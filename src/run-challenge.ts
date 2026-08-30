import { spawn } from "node:child_process";
import { createWriteStream } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { readAppSchema, type AppSchema } from "./app-schema.js";
import {
  finalizeVerifiedPartialResult,
  fallbackUnverifiedPartialResult,
  normalizeGeneratedEntry,
  prepareGeneratedTestHarness,
  writePartialReport,
} from "./finalize-generated-app.js";
import { handoffToSupportedNode } from "./node-runtime.js";
import { prepareOutput } from "./prepare-output.js";
import {
  scaffoldApiSummary,
  scaffoldDataLayer,
  scaffoldDataLayerTests,
  writeScaffoldFile,
  type ScaffoldFile,
} from "./scaffold-data-layer.js";
import { buildRepairBrief, type RepairBrief } from "./repair.js";
import { auditAppPortAfterPi } from "./port-owner.js";
import { signalProcessTree, terminateProcessTree, usesDetachedProcessGroup } from "./process-tree.js";
import {
  canonicalResultPath,
  composeResult,
  createRunIdentity,
  missingRequiredResultPaths,
  readPartialResult,
  rootStartCommand,
  writeResult,
} from "./result.js";
import { collectUsageFromJsonLines, weightedTokenScore } from "./usage.js";
import type { RunResult } from "./types.js";
import { validateResultObject } from "./validate-result.js";
import { portHasListener, unavailableAppVerification, verifyGeneratedApp } from "./verify-app.js";

interface Arguments {
  ideaFile: string;
  outputDirectory: string;
  prepareOnly: boolean;
  skipAppInstall: boolean;
}

export interface CommandResult {
  exitCode: number;
  timedOut: boolean;
}

interface PiOptions {
  environment?: Record<string, string>;
  label?: string;
}

const SOURCE_DIRECTORY = path.dirname(fileURLToPath(import.meta.url));
const REPOSITORY_ROOT = path.resolve(SOURCE_DIRECTORY, "..");
const APP_PORT = 3000;
const PROTECTED_EXTENSION = path.join(REPOSITORY_ROOT, "solution", "extensions", "protected-paths.ts");
const SCHEMA_EXTENSION = path.join(REPOSITORY_ROOT, "solution", "extensions", "submit-app-schema.ts");
const THINKING_EXTENSION = path.join(REPOSITORY_ROOT, "solution", "extensions", "thinking-off.ts");
const PI_BINARY = path.join(
  REPOSITORY_ROOT,
  "node_modules",
  ".bin",
  process.platform === "win32" ? "pi.cmd" : "pi",
);

export function runRequiresFailureExit(
  piExitCode: number,
  resultStatus: RunResult["status"],
  missingResultPaths: string[],
): boolean {
  return missingResultPaths.length > 0 || piExitCode !== 0 || resultStatus !== "success";
}

function printHelp(): void {
  console.log(`Usage: npm run challenge -- [options]

Options:
  --idea-file <path>      Idea prompt file (default: contract-public/development-idea.txt)
  --output-dir <path>     Generated app directory below output/ (default: output/app)
  --prepare-only          Reset the app from the seed without invoking Pi
  --skip-app-install      Do not run npm ci in the generated app
  --help                  Show this help

Environment:
  CHALLENGE_PROVIDER              Optional Pi provider override
  CHALLENGE_MODEL                 Optional Pi model override
  CHALLENGE_THINKING              Pi thinking level (default: off)
  CHALLENGE_TIMEOUT_MS            Wall-clock limit per top-level Pi phase (default: 3600000)
  CHALLENGE_EXPERIMENT_MAX_EUR    Safety ceiling for one run (default: 0.25)
  CHALLENGE_MAX_REPAIRS           Fresh verification repair sessions, 0-2 (default: 2)
  CHALLENGE_NODE_BINARY           Optional path to a Node 22 executable
`);
}

export function parseArguments(argv: string[]): Arguments {
  const parsed: Arguments = {
    ideaFile: path.join(REPOSITORY_ROOT, "contract-public", "development-idea.txt"),
    outputDirectory: path.join("output", "app"),
    prepareOnly: false,
    skipAppInstall: false,
  };

  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--help") {
      printHelp();
      process.exit(0);
    }
    if (argument === "--prepare-only") {
      parsed.prepareOnly = true;
      continue;
    }
    if (argument === "--skip-app-install") {
      parsed.skipAppInstall = true;
      continue;
    }
    if (argument === "--idea-file" || argument === "--output-dir") {
      const value = argv[index + 1];
      if (!value) throw new Error(`Missing value for ${argument}`);
      if (argument === "--idea-file") parsed.ideaFile = path.resolve(value);
      else parsed.outputDirectory = value;
      index += 1;
      continue;
    }
    throw new Error(`Unknown argument: ${argument}`);
  }
  return parsed;
}

function commandName(name: string): string {
  return process.platform === "win32" ? `${name}.cmd` : name;
}

async function runInherited(command: string, args: string[], cwd: string): Promise<number> {
  return await new Promise<number>((resolve, reject) => {
    const child = spawn(command, args, { cwd, stdio: "inherit", env: process.env, shell: false });
    child.once("error", reject);
    child.once("close", (code) => resolve(code ?? 1));
  });
}

function summarizeEventLine(line: string, label: string): void {
  try {
    const event = JSON.parse(line) as Record<string, unknown>;
    if (event.type === "tool_execution_end") {
      console.log(`[${label}] completed tool: ${String(event.toolName ?? "unknown")}`);
    }
    if (event.type === "message_end") {
      const message = event.message as Record<string, unknown> | undefined;
      const usage = message?.usage as Record<string, unknown> | undefined;
      if (message?.role === "assistant" && usage) {
        console.log(
          `[${label}] model call: input=${String(usage.input ?? 0)} output=${String(usage.output ?? 0)}`,
        );
      }
    }
  } catch {
    // The raw line remains in the audit artifact.
  }
}

export async function runPi(
  args: string[],
  cwd: string,
  eventFile: string,
  stderrFile: string,
  timeoutMs: number,
  options: PiOptions = {},
): Promise<CommandResult> {
  const events = createWriteStream(eventFile, { flags: "wx" });
  const errors = createWriteStream(stderrFile, { flags: "wx" });
  let lineBuffer = "";
  let piChild: ReturnType<typeof spawn> | undefined;
  const label = options.label ?? "pi";

  try {
    return await new Promise<CommandResult>((resolve, reject) => {
      const child = spawn(PI_BINARY, args, {
        cwd,
        detached: usesDetachedProcessGroup(),
        env: { ...process.env, ...options.environment, PI_OFFLINE: "1" },
        shell: false,
        stdio: ["ignore", "pipe", "pipe"],
      });
      piChild = child;
      let timedOut = false;
      let killTimer: NodeJS.Timeout | undefined;
      const timeout = setTimeout(() => {
        timedOut = true;
        signalProcessTree(child, "SIGTERM");
        killTimer = setTimeout(() => signalProcessTree(child, "SIGKILL"), 5_000);
      }, timeoutMs);

      child.stdout.on("data", (chunk: Buffer) => {
        events.write(chunk);
        lineBuffer += chunk.toString("utf8");
        const lines = lineBuffer.split(/\r?\n/u);
        lineBuffer = lines.pop() ?? "";
        for (const line of lines) summarizeEventLine(line, label);
      });
      child.stderr.pipe(errors);
      child.stderr.pipe(process.stderr);
      child.once("error", (error) => {
        clearTimeout(timeout);
        if (killTimer) clearTimeout(killTimer);
        reject(error);
      });
      child.once("close", (code) => {
        clearTimeout(timeout);
        if (killTimer) clearTimeout(killTimer);
        if (lineBuffer !== "") summarizeEventLine(lineBuffer, label);
        resolve({ exitCode: timedOut ? 124 : (code ?? 1), timedOut });
      });
    });
  } finally {
    if (piChild) await terminateProcessTree(piChild);
    await Promise.all([
      new Promise<void>((resolve) => events.end(resolve)),
      new Promise<void>((resolve) => errors.end(resolve)),
    ]);
  }
}

function modelArguments(): string[] {
  const args: string[] = [];
  if (process.env.CHALLENGE_PROVIDER) args.push("--provider", process.env.CHALLENGE_PROVIDER);
  if (process.env.CHALLENGE_MODEL) args.push("--model", process.env.CHALLENGE_MODEL);
  args.push("--thinking", process.env.CHALLENGE_THINKING ?? "off");
  return args;
}

export function buildPlannerArguments(idea: string, plannerPrompt: string, publicJourneys: string): string[] {
  return [
    "--mode",
    "json",
    "--print",
    "--offline",
    "--no-session",
    "--no-extensions",
    "--no-skills",
    "--no-prompt-templates",
    "--no-themes",
    "--no-context-files",
    "--system-prompt",
    `${plannerPrompt.trim()}\n\n${publicJourneys.trim()}`,
    "--extension",
    PROTECTED_EXTENSION,
    "--extension",
    THINKING_EXTENSION,
    "--extension",
    SCHEMA_EXTENSION,
    "--tools",
    "submit_app_schema",
    ...modelArguments(),
    `Plan this product idea:\n\n${idea.trim()}`,
  ];
}

export function buildOrchestratorArguments(
  _idea: string,
  schemaJson: string,
  orchestratorPrompt: string,
  _publicJourneys: string,
  appContext: string,
): string[] {
  return [
    "--mode",
    "json",
    "--print",
    "--offline",
    "--no-session",
    "--no-extensions",
    "--no-skills",
    "--no-prompt-templates",
    "--no-themes",
    "--no-context-files",
    "--system-prompt",
    `${appContext.trim()}\n\n${orchestratorPrompt.trim()}`,
    "--extension",
    PROTECTED_EXTENSION,
    "--extension",
    THINKING_EXTENSION,
    "--tools",
    "write",
    ...modelArguments(),
    `Validated app-schema.json:\n${schemaJson.trim()}\n\nGenerate every declared application file now.`,
  ];
}

export function buildRepairArguments(
  brief: RepairBrief,
  repairPrompt: string,
  appContext: string,
): string[] {
  return [
    "--mode",
    "json",
    "--print",
    "--offline",
    "--no-session",
    "--no-extensions",
    "--no-skills",
    "--no-prompt-templates",
    "--no-themes",
    "--no-context-files",
    "--system-prompt",
    `${appContext.trim()}\n\n${repairPrompt.trim()}`,
    "--extension",
    PROTECTED_EXTENSION,
    "--extension",
    THINKING_EXTENSION,
    "--tools",
    "read,write,edit",
    ...modelArguments(),
    `Repair brief:\n${JSON.stringify(brief)}\n\nRepair only the candidate files now.`,
  ];
}

// Compatibility alias for code that previously built the one-agent command.
export function buildPiArguments(
  idea: string,
  systemPrompt: string,
  publicJourneys: string,
  appContext: string,
  _artifactDirectory: string,
): string[] {
  return buildOrchestratorArguments(idea, "{}", systemPrompt, publicJourneys, appContext);
}

function timeoutFromEnvironment(): number {
  const raw = process.env.CHALLENGE_TIMEOUT_MS ?? "3600000";
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value < 1_000) {
    throw new Error("CHALLENGE_TIMEOUT_MS must be an integer of at least 1000");
  }
  return value;
}

function experimentBudgetFromEnvironment(): number {
  const value = Number(process.env.CHALLENGE_EXPERIMENT_MAX_EUR ?? "0.25");
  if (!Number.isFinite(value) || value <= 0 || value > 2) {
    throw new Error("CHALLENGE_EXPERIMENT_MAX_EUR must be greater than 0 and at most 2");
  }
  return value;
}

function maxRepairsFromEnvironment(): number {
  const value = Number(process.env.CHALLENGE_MAX_REPAIRS ?? "2");
  if (!Number.isSafeInteger(value) || value < 0 || value > 2) {
    throw new Error("CHALLENGE_MAX_REPAIRS must be an integer from 0 to 2");
  }
  return value;
}

export async function listAuditEventFiles(artifactDirectory: string): Promise<string[]> {
  const files = [path.join(artifactDirectory, "planner.events.jsonl")];
  const orchestratorEvents = path.join(artifactDirectory, "orchestrator.events.jsonl");
  try {
    await readFile(orchestratorEvents, "utf8");
    files.push(orchestratorEvents);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  for (let attempt = 1; attempt <= 2; attempt += 1) {
    const repairEvents = path.join(artifactDirectory, `repair-${String(attempt).padStart(2, "0")}.events.jsonl`);
    try {
      await readFile(repairEvents, "utf8");
      files.push(repairEvents);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }
  return files;
}

async function main(): Promise<void> {
  const handedOff = await handoffToSupportedNode(fileURLToPath(import.meta.url), process.argv.slice(2));
  if (handedOff !== undefined) {
    process.exitCode = handedOff;
    return;
  }

  const args = parseArguments(process.argv.slice(2));
  const idea = await readFile(args.ideaFile, "utf8");
  const outputDirectory = await prepareOutput(REPOSITORY_ROOT, args.outputDirectory);
  console.log(`Prepared clean application workspace: ${outputDirectory}`);

  if (!args.skipAppInstall) {
    const installCode = await runInherited(
      commandName("npm"),
      ["ci", "--ignore-scripts", "--prefer-offline"],
      outputDirectory,
    );
    if (installCode !== 0) throw new Error(`App dependency installation failed with exit code ${installCode}`);
  }
  await Promise.all([
    normalizeGeneratedEntry(outputDirectory),
    prepareGeneratedTestHarness(outputDirectory),
  ]);
  if (args.prepareOnly) return;

  const [plannerPrompt, orchestratorPrompt, repairPrompt, publicJourneys, appContext] = await Promise.all([
    readFile(path.join(REPOSITORY_ROOT, "solution", "planner", "system-prompt.md"), "utf8"),
    readFile(path.join(REPOSITORY_ROOT, "solution", "orchestrator", "system-prompt.md"), "utf8"),
    readFile(path.join(REPOSITORY_ROOT, "solution", "repair", "system-prompt.md"), "utf8"),
    readFile(path.join(REPOSITORY_ROOT, "contract-public", "journeys.md"), "utf8"),
    readFile(path.join(outputDirectory, "AGENTS.md"), "utf8"),
  ]);

  const runIdentity = createRunIdentity();
  const runId = runIdentity.run_id;
  const artifactDirectory = path.join(REPOSITORY_ROOT, "artifacts", "runs", runId);
  const savedResultPath = canonicalResultPath(REPOSITORY_ROOT, runId);
  await Promise.all([
    mkdir(artifactDirectory, { recursive: true }),
    mkdir(path.dirname(savedResultPath), { recursive: true }),
  ]);
  const ideaArtifact = path.join(artifactDirectory, "idea.txt");
  await writeFile(ideaArtifact, idea, "utf8");

  const timeoutMs = timeoutFromEnvironment();
  const experimentBudget = experimentBudgetFromEnvironment();
  const maxRepairs = maxRepairsFromEnvironment();
  const appPortHadListenerBeforePi = await portHasListener(APP_PORT);
  console.log("Planning prompt-specific architecture...");
  const planner = await runPi(
    buildPlannerArguments(idea, plannerPrompt, publicJourneys),
    outputDirectory,
    path.join(artifactDirectory, "planner.events.jsonl"),
    path.join(artifactDirectory, "planner.stderr.log"),
    timeoutMs,
    {
      label: "planner",
      environment: {
        CHALLENGE_AGENT_PHASE: "planner",
        CHALLENGE_MAX_OUTPUT_TOKENS: "2400",
        CHALLENGE_MAX_MODEL_CALLS: "2",
        CHALLENGE_MAX_AGENT_COST: "0.02",
      },
    },
  );

  let orchestrator: CommandResult = { exitCode: 1, timedOut: false };
  let schemaJson = "";
  let validatedSchema: AppSchema | undefined;
  if (planner.exitCode === 0) {
    try {
      const schemaPath = path.join(outputDirectory, "app-schema.json");
      validatedSchema = await readAppSchema(schemaPath);
      schemaJson = JSON.stringify(validatedSchema);
    } catch (error) {
      await writeFile(path.join(artifactDirectory, "schema-validation.log"), String(error), "utf8");
      console.error(String(error));
    }
  }

  // Types, storage access, and record CRUD follow mechanically from the validated schema.
  // Generating them here keeps them out of the model's output tokens, which cost three times
  // an input token, and makes malformed-storage recovery correct by construction.
  let scaffold: ScaffoldFile | undefined;
  let generationContext = appContext;
  if (validatedSchema) {
    scaffold = scaffoldDataLayer(validatedSchema);
    if (scaffold) {
      await writeScaffoldFile(outputDirectory, scaffold);
      const scaffoldTests = scaffoldDataLayerTests(validatedSchema, scaffold);
      if (scaffoldTests) await writeScaffoldFile(outputDirectory, scaffoldTests);
      generationContext = `${appContext.trim()}\n\n${scaffoldApiSummary(validatedSchema, scaffold, scaffoldTests)}`;
      console.log(`Generated the deterministic data layer: ${scaffold.path}`);
      if (scaffoldTests) console.log(`Generated deterministic data-layer tests: ${scaffoldTests.path}`);
    } else {
      console.log("This idea does not use a persisted record collection; no data layer was generated.");
    }
  }

  const plannerUsage = collectUsageFromJsonLines(
    await readFile(path.join(artifactDirectory, "planner.events.jsonl"), "utf8"),
  );
  if (schemaJson && plannerUsage.cost_total < experimentBudget) {
    console.log("Generating the validated application in one isolated phase...");
    orchestrator = await runPi(
      buildOrchestratorArguments(idea, schemaJson, orchestratorPrompt, publicJourneys, generationContext),
      outputDirectory,
      path.join(artifactDirectory, "orchestrator.events.jsonl"),
      path.join(artifactDirectory, "orchestrator.stderr.log"),
      timeoutMs,
      {
        label: "orchestrator",
        environment: {
          CHALLENGE_AGENT_PHASE: "orchestrator",
          CHALLENGE_ALLOWED_WRITE_PATHS: JSON.stringify(
            validatedSchema?.architecture.files.map((file) => file.path) ?? [],
          ),
          CHALLENGE_MAX_OUTPUT_TOKENS: "10000",
          CHALLENGE_MAX_MODEL_CALLS: "3",
          CHALLENGE_MAX_AGENT_COST: "0.12",
        },
      },
    );
  } else if (plannerUsage.cost_total >= experimentBudget) {
    console.error("Experiment budget was exhausted by planning; implementation was not started.");
  }

  let combinedExitCode = planner.exitCode === 0 && schemaJson ? orchestrator.exitCode : 1;
  const portReclamation = await auditAppPortAfterPi(APP_PORT, outputDirectory, appPortHadListenerBeforePi);
  if (portReclamation.listener_after_pi) {
    const message = `${portReclamation.diagnostic}; pids=${portReclamation.process_ids.join(",") || "none"}`;
    if (portReclamation.reclaimed) console.log(message);
    else console.warn(message);
  }

  let eventFiles = await listAuditEventFiles(artifactDirectory);
  let usage = collectUsageFromJsonLines(
    (await Promise.all(eventFiles.map(async (file) => await readFile(file, "utf8")))).join("\n"),
  );
  let partial = await readPartialResult(outputDirectory);
  const canVerifyApp = combinedExitCode === 0 && usage.model_calls > 0 && validatedSchema !== undefined;
  const startCommand = rootStartCommand(REPOSITORY_ROOT, outputDirectory);
  let verification = unavailableAppVerification(
    canVerifyApp ? "app verification had not completed" : "Generation did not complete with audited model usage",
  );
  let result = composeResult(
    partial,
    usage,
    combinedExitCode,
    verification,
    portReclamation,
    startCommand,
    runIdentity,
  );
  const appResultPath = path.join(outputDirectory, "result.json");
  const requiredResultPaths = [appResultPath, savedResultPath];
  let resultPaths = await writeResult(outputDirectory, result, [savedResultPath]);
  let repairTimedOut = false;
  if (canVerifyApp && validatedSchema) {
    let verificationAttempt = 0;
    while (verificationAttempt <= maxRepairs) {
      const attemptDirectory = path.join(
        artifactDirectory,
        "verification",
        `attempt-${String(verificationAttempt).padStart(2, "0")}`,
      );
      await mkdir(attemptDirectory, { recursive: true });
      try {
        await normalizeGeneratedEntry(outputDirectory);
        verification = await verifyGeneratedApp(outputDirectory, attemptDirectory, {
          displayRoot: REPOSITORY_ROOT,
        });
      } catch (error) {
        const reason = `Generated entry normalization failed: ${String(error)}`;
        console.error(reason);
        verification = unavailableAppVerification(reason);
      }

      if (verification.passed || verificationAttempt === maxRepairs) break;

      eventFiles = await listAuditEventFiles(artifactDirectory);
      usage = collectUsageFromJsonLines(
        (await Promise.all(eventFiles.map(async (file) => await readFile(file, "utf8")))).join("\n"),
      );
      const remainingBudget = experimentBudget - usage.cost_total;
      if (remainingBudget < 0.005) {
        console.error("Experiment budget is too low to start another repair phase.");
        break;
      }

      const repairAttempt = (verificationAttempt + 1) as 1 | 2;
      const brief = buildRepairBrief(validatedSchema, verification, repairAttempt);
      const repair = await runPi(
        buildRepairArguments(brief, repairPrompt, generationContext),
        outputDirectory,
        path.join(artifactDirectory, `repair-${String(repairAttempt).padStart(2, "0")}.events.jsonl`),
        path.join(artifactDirectory, `repair-${String(repairAttempt).padStart(2, "0")}.stderr.log`),
        timeoutMs,
        {
          label: `repair-${repairAttempt}`,
          environment: {
            CHALLENGE_AGENT_PHASE: `repair:${repairAttempt}`,
            CHALLENGE_ALLOWED_WRITE_PATHS: JSON.stringify(brief.candidate_files.map((file) => file.path)),
            CHALLENGE_MAX_OUTPUT_TOKENS: "4000",
            CHALLENGE_MAX_MODEL_CALLS: "4",
            CHALLENGE_MAX_AGENT_COST: String(Math.min(0.04, remainingBudget)),
          },
        },
      );
      repairTimedOut ||= repair.timedOut;
      if (repair.exitCode !== 0) {
        combinedExitCode = repair.exitCode;
        break;
      }
      verificationAttempt = repairAttempt;
    }

    if (verification.passed) {
      partial = finalizeVerifiedPartialResult(partial, validatedSchema, verification);
    } else {
      partial = fallbackUnverifiedPartialResult(validatedSchema, verification);
    }
    await writePartialReport(outputDirectory, partial);

    eventFiles = await listAuditEventFiles(artifactDirectory);
    usage = collectUsageFromJsonLines(
      (await Promise.all(eventFiles.map(async (file) => await readFile(file, "utf8")))).join("\n"),
    );
    result = composeResult(
      partial,
      usage,
      combinedExitCode,
      verification,
      portReclamation,
      startCommand,
      runIdentity,
    );
    resultPaths = await writeResult(outputDirectory, result, [savedResultPath]);
  }
  const missingResultPaths = missingRequiredResultPaths(resultPaths, requiredResultPaths);
  const validationErrors = await validateResultObject(result);
  if (validationErrors.length > 0) {
    for (const error of validationErrors) console.error(`- ${error}`);
    process.exitCode = 1;
    return;
  }

  console.log(`Result written to ${resultPaths.join(" and ")}`);
  console.log(`Canonical run result: ${savedResultPath}`);
  console.log(`Audit artifacts written to ${artifactDirectory}`);
  console.log(
    `Audited usage: calls=${usage.model_calls}, weighted-score=${weightedTokenScore(usage).toFixed(1)}, cost=${usage.cost_total.toFixed(4)}`,
  );
  if (usage.cost_total > experimentBudget) {
    console.error(`Audited cost exceeded the €${experimentBudget.toFixed(2)} safety target; no further run was started.`);
  }
  for (const missingResultPath of missingResultPaths) {
    console.error(`Required result destination was not written: ${missingResultPath}`);
  }
  if (planner.timedOut || orchestrator.timedOut || repairTimedOut) {
    console.error("A Pi phase exceeded CHALLENGE_TIMEOUT_MS.");
  }
  if (runRequiresFailureExit(combinedExitCode, result.status, missingResultPaths)) process.exitCode = 1;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await main();
}
