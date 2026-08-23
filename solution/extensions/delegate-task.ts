import { spawn } from "node:child_process";
import { createWriteStream, existsSync, mkdirSync, readFileSync } from "node:fs";
import path from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { AGENT_ROLES, type AgentRole, type AppSchema } from "../../src/app-schema.js";

const Params = Type.Object({});
const TargetedParams = Type.Object({
  agent: Type.Union([Type.Literal("domain"), Type.Literal("experience"), Type.Literal("quality")]),
});

interface ChildResult {
  exitCode: number;
  finalText: string;
  stderr: string;
}

const ROLE_INSTRUCTIONS: Record<AgentRole, string> = {
  domain:
    "Implement only the assigned domain, state, and persistence files. The schema is sufficient: do not inspect the starter. Write every assigned file immediately. Use plain TypeScript with no React imports, keep the whole domain implementation under 200 lines, and make it resilient to malformed browser storage. Do not build UI or tests.",
  experience:
    "Implement only the assigned interface files. Read the domain files together once, then write every assigned interface file in one response. Keep App.tsx under 320 lines, styles.css under 220 lines, and any extra component under 160 lines. Create a distinctive, responsive, accessible experience matching visual_direction and every journey. Do not inspect project configuration or create a generic dashboard shell.",
  quality:
    "Act as integration and quality owner. Read generated implementation files in one batch, implement one compact test file under 180 lines with at most three tests, favoring domain and persistence tests plus at most one UI smoke test. Run DEBUG_PRINT_LIMIT=1000 npm test -- --reporter=dot and npm run build, then repair real defects in one batch. Never write reporting JSON or weaken assertions to hide defects.",
};

function parseFinalText(event: unknown): string | undefined {
  if (typeof event !== "object" || event === null) return undefined;
  const record = event as Record<string, unknown>;
  if (record.type !== "message_end" || typeof record.message !== "object" || record.message === null) {
    return undefined;
  }
  const message = record.message as Record<string, unknown>;
  if (message.role !== "assistant" || !Array.isArray(message.content)) return undefined;
  const text = message.content
    .filter(
      (block): block is Record<string, unknown> =>
        typeof block === "object" && block !== null && (block as Record<string, unknown>).type === "text",
    )
    .map((block) => String(block.text ?? ""))
    .join("\n")
    .trim();
  return text || undefined;
}

function childSystemPrompt(agent: AgentRole, idea: string, schema: AppSchema, files: string[]): string {
  return `You are a targeted implementation agent working in a copied React starter. ${ROLE_INSTRUCTIONS[agent]}

The repository's app-template is outside this workspace and immutable. Use only installed dependencies. Never install packages, start a dev server, or write result.json. You may read any app file, but writes are restricted to these files:
${files.map((file) => `- ${file}`).join("\n")}

Product idea:
${idea.trim()}

Shared implementation blueprint:
${JSON.stringify(schema)}

Finish the assigned work autonomously. Keep the implementation compact and maintainable. End with a factual summary of at most 40 words.`;
}

function stopProcess(child: ReturnType<typeof spawn>, signal: NodeJS.Signals): void {
  if (child.pid && process.platform !== "win32") {
    try {
      process.kill(-child.pid, signal);
      return;
    } catch {
      // Fall through to direct signalling when no detached group exists.
    }
  }
  child.kill(signal);
}

async function runChild(
  cwd: string,
  agent: AgentRole,
  schema: AppSchema,
  idea: string,
  sequence: number,
  signal: AbortSignal | undefined,
): Promise<ChildResult> {
  const task = schema.tasks.find((candidate) => candidate.agent === agent);
  if (!task) return { exitCode: 1, finalText: "", stderr: `No ${agent} task exists in app-schema.json` };

  const piBinary = process.env.CHALLENGE_PI_BINARY;
  const protectedExtension = process.env.CHALLENGE_PROTECTED_EXTENSION;
  const artifactDirectory = process.env.CHALLENGE_ARTIFACT_DIRECTORY;
  if (!piBinary || !protectedExtension || !artifactDirectory) {
    return { exitCode: 1, finalText: "", stderr: "Runner did not configure delegated execution" };
  }

  const subagentDirectory = path.join(artifactDirectory, "subagents");
  mkdirSync(subagentDirectory, { recursive: true });
  const prefix = `${String(sequence).padStart(2, "0")}-${agent}`;
  const eventStream = createWriteStream(path.join(subagentDirectory, `${prefix}.events.jsonl`), { flags: "wx" });
  const errorStream = createWriteStream(path.join(subagentDirectory, `${prefix}.stderr.log`), { flags: "wx" });
  const allowedWritePaths =
    agent === "quality"
      ? Array.from(new Set(schema.tasks.flatMap((candidate) => candidate.files)))
      : task.files;
  const tools =
    agent === "domain"
      ? "write"
      : agent === "experience"
        ? "read,write,edit"
        : "read,write,edit,bash,grep,find,ls";
  const args = [
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
    childSystemPrompt(agent, idea, schema, allowedWritePaths),
    "--extension",
    protectedExtension,
    "--tools",
    tools,
  ];
  if (process.env.CHALLENGE_PROVIDER) args.push("--provider", process.env.CHALLENGE_PROVIDER);
  if (process.env.CHALLENGE_MODEL) args.push("--model", process.env.CHALLENGE_MODEL);
  args.push("--thinking", process.env.CHALLENGE_THINKING ?? "off");
  args.push(`Complete the ${agent} task: ${task.goal}`);

  return await new Promise<ChildResult>((resolve) => {
    const child = spawn(piBinary, args, {
      cwd,
      detached: process.platform !== "win32",
      env: {
        ...process.env,
        PI_OFFLINE: "1",
        CHALLENGE_AGENT_PHASE: `subagent:${agent}`,
        CHALLENGE_ALLOWED_WRITE_PATHS: JSON.stringify(allowedWritePaths),
        CHALLENGE_MAX_OUTPUT_TOKENS: process.env.CHALLENGE_SUBAGENT_MAX_OUTPUT_TOKENS ?? "10000",
        CHALLENGE_MAX_MODEL_CALLS: process.env.CHALLENGE_SUBAGENT_MAX_MODEL_CALLS ?? "10",
        CHALLENGE_MAX_AGENT_COST: process.env.CHALLENGE_SUBAGENT_MAX_COST ?? "0.05",
      },
      shell: false,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdoutBuffer = "";
    let lineBuffer = "";
    let stderr = "";
    let finalText = "";
    let timedOut = false;
    let killTimer: NodeJS.Timeout | undefined;
    const timeoutMs = Number(process.env.CHALLENGE_SUBAGENT_TIMEOUT_MS ?? "600000");
    const timeout = setTimeout(() => {
      timedOut = true;
      stopProcess(child, "SIGTERM");
      killTimer = setTimeout(() => stopProcess(child, "SIGKILL"), 5_000);
    }, Number.isSafeInteger(timeoutMs) && timeoutMs >= 1_000 ? timeoutMs : 600_000);

    const processLine = (line: string) => {
      if (!line.trim()) return;
      try {
        const parsed = JSON.parse(line) as unknown;
        finalText = parseFinalText(parsed) ?? finalText;
        if (typeof parsed === "object" && parsed !== null) {
          const record = parsed as Record<string, unknown>;
          const message = record.message as Record<string, unknown> | undefined;
          if (record.type === "message_end" && message?.role === "assistant" && message.stopReason === "length") {
            stderr += "Subagent response reached its output limit.";
            stopProcess(child, "SIGTERM");
          }
        }
      } catch {
        // Raw malformed lines remain in the audit file and are ignored here.
      }
    };

    child.stdout.on("data", (chunk: Buffer) => {
      eventStream.write(chunk);
      stdoutBuffer += chunk.toString("utf8");
      lineBuffer += chunk.toString("utf8");
      const lines = lineBuffer.split(/\r?\n/u);
      lineBuffer = lines.pop() ?? "";
      for (const line of lines) processLine(line);
    });
    child.stderr.on("data", (chunk: Buffer) => {
      errorStream.write(chunk);
      stderr += chunk.toString("utf8");
    });
    child.once("error", (error) => {
      stderr += error.message;
    });
    child.once("close", (code) => {
      clearTimeout(timeout);
      if (killTimer) clearTimeout(killTimer);
      if (lineBuffer) processLine(lineBuffer);
      const missingFiles = task.files.filter((file) => !existsSync(path.join(cwd, file)));
      Promise.all([
        new Promise<void>((finished) => eventStream.end(finished)),
        new Promise<void>((finished) => errorStream.end(finished)),
      ]).then(() => {
        resolve({
          exitCode: timedOut || missingFiles.length > 0 ? (timedOut ? 124 : 1) : (code ?? 1),
          finalText: finalText.slice(0, 1_200),
          stderr:
            missingFiles.length > 0
              ? `Subagent did not produce assigned files: ${missingFiles.join(", ")}`
              : stderr.slice(-1_200) || (stdoutBuffer.trim() ? "" : "Subagent produced no output"),
        });
      });
    });

    const abort = () => {
      stopProcess(child, "SIGTERM");
      setTimeout(() => stopProcess(child, "SIGKILL"), 5_000).unref();
    };
    if (signal?.aborted) abort();
    else signal?.addEventListener("abort", abort, { once: true });
  });
}

export default function delegateTask(pi: ExtensionAPI) {
  let completed = false;
  const targetedRoles = new Set<AgentRole>();
  let targetedSequence = 0;

  pi.registerTool({
    name: "delegate_all",
    label: "Execute schema tasks",
    description:
      "Execute all validated app-schema tasks sequentially with isolated domain, experience, and quality agents.",
    parameters: Params,
    async execute(_toolCallId, _params, signal, _onUpdate, context) {
      if (completed) {
        return { content: [{ type: "text", text: "Schema tasks were already executed." }], details: {}, isError: true };
      }

      let schema: AppSchema;
      let idea: string;
      try {
        schema = JSON.parse(readFileSync(path.join(context.cwd, "app-schema.json"), "utf8")) as AppSchema;
        idea = readFileSync(String(process.env.CHALLENGE_IDEA_FILE), "utf8");
      } catch (error) {
        return {
          content: [{ type: "text", text: `Could not load delegated task inputs: ${(error as Error).message}` }],
          details: {},
          isError: true,
        };
      }

      completed = true;
      const results: Array<{ agent: AgentRole; result: ChildResult }> = [];
      for (const agent of AGENT_ROLES) {
        const result = await runChild(context.cwd, agent, schema, idea, results.length + 1, signal);
        results.push({ agent, result });
        if (result.exitCode !== 0) break;
      }
      const summaries = results.map(({ agent, result }, index) => {
        const audit = `subagents/${String(index + 1).padStart(2, "0")}-${agent}.events.jsonl`;
        return `${agent}: ${result.exitCode === 0 ? result.finalText || "completed" : result.stderr || "failed"} (${audit})`;
      });
      const failed = results.find(({ result }) => result.exitCode !== 0);
      return {
        content: [{ type: "text", text: summaries.join("\n").slice(0, 3_000) }],
        details: { results: results.map(({ agent, result }) => ({ agent, exitCode: result.exitCode })) },
        ...(failed ? { isError: true } : {}),
      };
    },
  });

  pi.registerTool({
    name: "delegate_task",
    label: "Targeted schema repair",
    description:
      "Run one isolated role agent for a specific unresolved implementation or verification failure. Use only after an integrated repair attempt.",
    parameters: TargetedParams,
    async execute(_toolCallId, params, signal, _onUpdate, context) {
      const agent = params.agent as AgentRole;
      const limit = Number(process.env.CHALLENGE_MAX_DELEGATIONS ?? "1");
      if (targetedRoles.has(agent) || targetedRoles.size >= limit) {
        return {
          content: [{ type: "text", text: "Targeted delegation limit reached for this role." }],
          details: { agent, exitCode: 1 },
          isError: true,
        };
      }

      let schema: AppSchema;
      let idea: string;
      try {
        schema = JSON.parse(readFileSync(path.join(context.cwd, "app-schema.json"), "utf8")) as AppSchema;
        idea = readFileSync(String(process.env.CHALLENGE_IDEA_FILE), "utf8");
      } catch (error) {
        return {
          content: [{ type: "text", text: `Could not load repair inputs: ${(error as Error).message}` }],
          details: { agent, exitCode: 1 },
          isError: true,
        };
      }

      targetedRoles.add(agent);
      targetedSequence += 1;
      const result = await runChild(context.cwd, agent, schema, idea, targetedSequence, signal);
      const audit = `subagents/${String(targetedSequence).padStart(2, "0")}-${agent}.events.jsonl`;
      return {
        content: [
          {
            type: "text",
            text:
              result.exitCode === 0
                ? `${result.finalText || `${agent} repair completed.`}\nAudited child events: ${audit}`
                : `${agent} repair failed: ${result.stderr || result.finalText}\nAudited child events: ${audit}`,
          },
        ],
        details: { agent, exitCode: result.exitCode },
        ...(result.exitCode === 0 ? {} : { isError: true }),
      };
    },
  });
}
