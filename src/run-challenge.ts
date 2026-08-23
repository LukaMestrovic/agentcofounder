import { spawn } from "node:child_process";
import { createWriteStream } from "node:fs";
import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { readAppSchema, type AppSchema } from "./app-schema.js";
import {
  finalizeVerifiedPartialResult,
  normalizeGeneratedEntry,
  prepareGeneratedTestHarness,
  writePartialReport,
} from "./finalize-generated-app.js";
import { handoffToSupportedNode } from "./node-runtime.js";
import { prepareOutput } from "./prepare-output.js";
import { auditAppPortAfterPi } from "./port-owner.js";
import { signalProcessTree, terminateProcessTree, usesDetachedProcessGroup } from "./process-tree.js";
import {
  composeResult,
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
const DELEGATE_EXTENSION = path.join(REPOSITORY_ROOT, "solution", "extensions", "delegate-task.ts");
const SCHEMA_EXTENSION = path.join(REPOSITORY_ROOT, "solution", "extensions", "submit-app-schema.ts");
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
  CHALLENGE_TIMEOUT_MS            Wall-clock limit per top-level Pi phase (default: 900000)
  CHALLENGE_EXPERIMENT_MAX_EUR    Safety ceiling for one run (default: 0.25)
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
    SCHEMA_EXTENSION,
    "--tools",
    "submit_app_schema",
    ...modelArguments(),
    `Plan this product idea:\n\n${idea.trim()}`,
  ];
}

export function buildOrchestratorArguments(
  idea: string,
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
    `${orchestratorPrompt.trim()}\n\n${appContext.trim()}`,
    "--extension",
    PROTECTED_EXTENSION,
    "--extension",
    DELEGATE_EXTENSION,
    "--tools",
    "read,write,edit,bash,delegate_task",
    ...modelArguments(),
    `Product idea:\n${idea.trim()}\n\nValidated app-schema.json:\n${schemaJson.trim()}\n\nImplement and verify the application now.`,
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
  const raw = process.env.CHALLENGE_TIMEOUT_MS ?? "900000";
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

export async function listAuditEventFiles(artifactDirectory: string): Promise<string[]> {
  const files = [path.join(artifactDirectory, "planner.events.jsonl")];
  const subagentDirectory = path.join(artifactDirectory, "subagents");
  try {
    const children = await readdir(subagentDirectory, { withFileTypes: true });
    files.push(
      ...children
        .filter((child) => child.isFile() && child.name.endsWith(".events.jsonl"))
        .map((child) => path.join(subagentDirectory, child.name))
        .sort(),
    );
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  const orchestratorEvents = path.join(artifactDirectory, "orchestrator.events.jsonl");
  try {
    await readFile(orchestratorEvents, "utf8");
    files.push(orchestratorEvents);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
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

  const [plannerPrompt, orchestratorPrompt, publicJourneys, appContext] = await Promise.all([
    readFile(path.join(REPOSITORY_ROOT, "solution", "planner", "system-prompt.md"), "utf8"),
    readFile(path.join(REPOSITORY_ROOT, "solution", "orchestrator", "system-prompt.md"), "utf8"),
    readFile(path.join(REPOSITORY_ROOT, "contract-public", "journeys.md"), "utf8"),
    readFile(path.join(outputDirectory, "AGENTS.md"), "utf8"),
  ]);

  const runId = new Date().toISOString().replaceAll(":", "-").replaceAll(".", "-");
  const artifactDirectory = path.join(REPOSITORY_ROOT, "artifacts", "runs", runId);
  await mkdir(artifactDirectory, { recursive: true });
  const ideaArtifact = path.join(artifactDirectory, "idea.txt");
  await writeFile(ideaArtifact, idea, "utf8");

  const timeoutMs = timeoutFromEnvironment();
  const experimentBudget = experimentBudgetFromEnvironment();
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
      schemaJson = await readFile(schemaPath, "utf8");
    } catch (error) {
      await writeFile(path.join(artifactDirectory, "schema-validation.log"), String(error), "utf8");
      console.error(String(error));
    }
  }

  const plannerUsage = collectUsageFromJsonLines(
    await readFile(path.join(artifactDirectory, "planner.events.jsonl"), "utf8"),
  );
  if (schemaJson && plannerUsage.cost_total < experimentBudget) {
    console.log("Executing the validated schema with the integrated builder...");
    orchestrator = await runPi(
      buildOrchestratorArguments(idea, schemaJson, orchestratorPrompt, publicJourneys, appContext),
      outputDirectory,
      path.join(artifactDirectory, "orchestrator.events.jsonl"),
      path.join(artifactDirectory, "orchestrator.stderr.log"),
      timeoutMs,
      {
        label: "orchestrator",
        environment: {
          CHALLENGE_AGENT_PHASE: "orchestrator",
          CHALLENGE_ARTIFACT_DIRECTORY: artifactDirectory,
          CHALLENGE_IDEA_FILE: ideaArtifact,
          CHALLENGE_PI_BINARY: PI_BINARY,
          CHALLENGE_PROTECTED_EXTENSION: PROTECTED_EXTENSION,
          CHALLENGE_MAX_DELEGATIONS: "1",
          CHALLENGE_MAX_OUTPUT_TOKENS: "10000",
          CHALLENGE_MAX_MODEL_CALLS: "25",
          CHALLENGE_MAX_AGENT_COST: "0.12",
          CHALLENGE_SUBAGENT_MAX_OUTPUT_TOKENS: "10000",
          CHALLENGE_SUBAGENT_MAX_MODEL_CALLS: "10",
          CHALLENGE_SUBAGENT_MAX_COST: "0.05",
          CHALLENGE_SUBAGENT_TIMEOUT_MS: "600000",
        },
      },
    );
  } else if (plannerUsage.cost_total >= experimentBudget) {
    console.error("Experiment budget was exhausted by planning; implementation was not started.");
  }

  const combinedExitCode = planner.exitCode === 0 && schemaJson ? orchestrator.exitCode : 1;
  if (combinedExitCode === 0) {
    try {
      await normalizeGeneratedEntry(outputDirectory);
    } catch (error) {
      console.error(`Generated entry normalization failed: ${String(error)}`);
    }
  }
  const portReclamation = await auditAppPortAfterPi(APP_PORT, outputDirectory, appPortHadListenerBeforePi);
  if (portReclamation.listener_after_pi) {
    const message = `${portReclamation.diagnostic}; pids=${portReclamation.process_ids.join(",") || "none"}`;
    if (portReclamation.reclaimed) console.log(message);
    else console.warn(message);
  }

  const eventFiles = await listAuditEventFiles(artifactDirectory);
  const usage = collectUsageFromJsonLines(
    (await Promise.all(eventFiles.map(async (file) => await readFile(file, "utf8")))).join("\n"),
  );
  let partial = await readPartialResult(outputDirectory);
  const canVerifyApp = combinedExitCode === 0 && usage.model_calls > 0;
  const startCommand = rootStartCommand(REPOSITORY_ROOT, outputDirectory);
  let verification = unavailableAppVerification(
    canVerifyApp ? "app verification had not completed" : "Generation did not complete with audited model usage",
  );
  let result = composeResult(partial, usage, combinedExitCode, verification, portReclamation, startCommand);
  const appResultPath = path.join(outputDirectory, "result.json");
  const rootResultPath = path.join(REPOSITORY_ROOT, "result.json");
  const requiredResultPaths = [appResultPath, rootResultPath];
  let resultPaths = await writeResult(outputDirectory, result, [rootResultPath]);
  if (canVerifyApp) {
    verification = await verifyGeneratedApp(outputDirectory, artifactDirectory, { displayRoot: REPOSITORY_ROOT });
    if (verification.passed && validatedSchema) {
      partial = finalizeVerifiedPartialResult(partial, validatedSchema, verification);
      await writePartialReport(outputDirectory, partial);
    }
    result = composeResult(partial, usage, combinedExitCode, verification, portReclamation, startCommand);
    resultPaths = await writeResult(outputDirectory, result, [rootResultPath]);
  }
  const missingResultPaths = missingRequiredResultPaths(resultPaths, requiredResultPaths);
  const validationErrors = await validateResultObject(result);
  if (validationErrors.length > 0) {
    for (const error of validationErrors) console.error(`- ${error}`);
    process.exitCode = 1;
    return;
  }

  console.log(`Result written to ${resultPaths.join(" and ")}`);
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
  if (planner.timedOut || orchestrator.timedOut) console.error("A Pi phase exceeded CHALLENGE_TIMEOUT_MS.");
  if (runRequiresFailureExit(combinedExitCode, result.status, missingResultPaths)) process.exitCode = 1;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await main();
}
