import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import path from "node:path";

export const PI_DOCUMENTATION_HEADING = "Pi documentation (read only when ";
const PI_DOCUMENTATION_BLOCK_START = `\n\n${PI_DOCUMENTATION_HEADING}`;

export function stripPiDocumentationBlock(systemPrompt: string): string {
  const blockStart = systemPrompt.indexOf(PI_DOCUMENTATION_BLOCK_START);
  if (blockStart < 0) return systemPrompt;

  const headingEnd = systemPrompt.indexOf("\n", blockStart + PI_DOCUMENTATION_BLOCK_START.length);
  if (headingEnd < 0) return systemPrompt;

  let lineStart = headingEnd + 1;
  let bulletCount = 0;
  while (systemPrompt.startsWith("- ", lineStart)) {
    bulletCount += 1;
    const lineEnd = systemPrompt.indexOf("\n", lineStart);
    if (lineEnd < 0) return systemPrompt.slice(0, blockStart);
    lineStart = lineEnd + 1;
  }
  if (bulletCount === 0) return systemPrompt;

  return systemPrompt.slice(0, blockStart) + systemPrompt.slice(Math.max(blockStart, lineStart - 1));
}

export default function protectedPaths(pi: ExtensionAPI) {
  const appRoot = process.cwd();
  let completedModelCalls = 0;
  let auditedCost = 0;

  pi.on("before_provider_request", (event) => {
    const rawCap = process.env.CHALLENGE_MAX_OUTPUT_TOKENS;
    if (!rawCap) return undefined;
    const cap = Number(rawCap);
    if (!Number.isSafeInteger(cap) || cap < 256 || typeof event.payload !== "object" || event.payload === null) {
      return undefined;
    }
    return {
      ...(event.payload as Record<string, unknown>),
      max_tokens: cap,
      max_completion_tokens: cap,
    };
  });

  pi.on("before_agent_start", async (event) => ({
    systemPrompt: stripPiDocumentationBlock(event.systemPrompt),
  }));

  pi.on("message_end", async (event) => {
    if (event.message.role !== "assistant") return undefined;
    completedModelCalls += 1;
    auditedCost += event.message.usage.cost?.total ?? 0;
    return undefined;
  });

  pi.on("turn_end", async (_event, context) => {
    const callLimit = Number(process.env.CHALLENGE_MAX_MODEL_CALLS ?? "0");
    const costLimit = Number(process.env.CHALLENGE_MAX_AGENT_COST ?? "0");
    const callsExceeded = Number.isSafeInteger(callLimit) && callLimit > 0 && completedModelCalls >= callLimit;
    const costExceeded = Number.isFinite(costLimit) && costLimit > 0 && auditedCost >= costLimit;
    if (callsExceeded || costExceeded) context.abort();
  });

  pi.on("tool_call", async (event, context) => {
    const mutatingTool = event.toolName === "write" || event.toolName === "edit";
    const repairRead = event.toolName === "read" && process.env.CHALLENGE_AGENT_PHASE?.startsWith("repair:");
    if (!mutatingTool && !repairRead) return undefined;
    const candidate = String((event.input as Record<string, unknown>).path ?? "");
    const absolute = path.resolve(appRoot, candidate);
    const relative = path.relative(appRoot, absolute);
    const outsideApp = relative.startsWith("..") || path.isAbsolute(relative);
    const segments = relative.split(path.sep);
    const basename = path.basename(absolute).toLowerCase();
    const protectedPath =
      outsideApp ||
      segments.includes(".git") ||
      segments.includes("node_modules") ||
      basename === "result.json" ||
      basename === ".env" ||
      basename.startsWith(".env.");
    const plannerViolation =
      process.env.CHALLENGE_AGENT_PHASE === "planner" && relative !== "app-schema.json";
    let assignmentViolation = false;
    const allowedPathsJson = process.env.CHALLENGE_ALLOWED_WRITE_PATHS;
    if (allowedPathsJson) {
      try {
        const allowedPaths = JSON.parse(allowedPathsJson) as unknown;
        assignmentViolation =
          !Array.isArray(allowedPaths) ||
          !allowedPaths.some(
            (allowed) => typeof allowed === "string" && path.normalize(allowed) === path.normalize(relative),
          );
      } catch {
        assignmentViolation = true;
      }
    }
    if (!protectedPath && !plannerViolation && !assignmentViolation) return undefined;

    if (context.hasUI) context.ui.notify(`Blocked file access outside phase scope: ${candidate}`, "warning");
    return {
      block: true,
      reason: plannerViolation
        ? "The planner may only write app-schema.json"
        : assignmentViolation
          ? repairRead
            ? "The repair may only read its candidate files"
            : "This path belongs to a different implementation task"
          : "Path is outside the app workspace or is runner-owned",
    };
  });
}
