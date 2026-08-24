import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

/**
 * Makes `--thinking off` actually reach the model.
 *
 * Pi decides whether a model speaks Z.ai's wire format from the provider name or the base URL
 * (`detectCompat` in pi-ai `openai-completions.js` matches `zai`, `api.z.ai`, `open.bigmodel.cn`).
 * Berget serves GLM from `api.berget.ai`, which matches none of them, so the thinking format
 * resolves to "openai", the chain looks up `model.thinkingLevelMap.off`, finds nothing, and adds
 * no thinking field at all. GLM then runs at its documented default: thinking enabled,
 * `reasoning_effort` max.
 *
 * Measured against Berget with four 16-token probes on 2026-08-24:
 *
 *   baseline                                  70 reasoning chars
 *   thinking: {type: "disabled"}              58 reasoning chars  (not honoured)
 *   chat_template_kwargs: {enable_thinking}    0 reasoning chars  (honoured)
 *   reasoning_effort: "none"                   0 reasoning chars  (honoured)
 *
 * The configuration for this normally lives in `~/.pi/agent/models.json`, which is untracked and
 * absent on any other machine. Patching the outgoing payload keeps it in the repository.
 */

/** Wire formats for "do not think". Chosen by `CHALLENGE_THINKING_FORMAT`. */
export type ThinkingWireFormat = "chat-template" | "zai" | "reasoning-effort" | "none";

const DEFAULT_FORMAT: ThinkingWireFormat = "chat-template";

export function thinkingWireFormat(raw: string | undefined): ThinkingWireFormat {
  const value = (raw ?? "").trim().toLowerCase();
  if (value === "") return DEFAULT_FORMAT;
  if (value === "chat-template" || value === "zai" || value === "reasoning-effort" || value === "none") {
    return value;
  }
  throw new Error(
    `CHALLENGE_THINKING_FORMAT must be one of chat-template, zai, reasoning-effort, none (got "${raw}")`,
  );
}

/**
 * Only GLM is known to think when it was told not to. Leaving every other model alone means a run
 * on a different provider cannot be broken by a field its server has never heard of.
 */
export function isThinkingCapableModel(model: unknown): boolean {
  return typeof model === "string" && /glm/iu.test(model);
}

export function applyThinkingOff(
  payload: Record<string, unknown>,
  format: ThinkingWireFormat,
): Record<string, unknown> {
  switch (format) {
    case "chat-template":
      // vLLM and SGLang render the GLM chat template; this is the switch it reads.
      return { ...payload, chat_template_kwargs: { enable_thinking: false } };
    case "zai":
      return { ...payload, thinking: { type: "disabled" } };
    case "reasoning-effort":
      return { ...payload, reasoning_effort: "none" };
    case "none":
      return payload;
  }
}

/**
 * True for every spelling of "do not think" the two ThinkingLevel unions use: pi-ai's omits "off"
 * and represents it as undefined, pi-agent-core's includes it. Comparing against only one of them
 * makes this hook silently never fire, which is the bug it exists to fix.
 */
export function thinkingIsOff(level: string | undefined): boolean {
  return level === "off" || level === undefined;
}

export default function thinkingOff(pi: ExtensionAPI) {
  const format = thinkingWireFormat(process.env.CHALLENGE_THINKING_FORMAT);
  let announced = false;

  pi.on("before_provider_request", (event, context) => {
    if (typeof event.payload !== "object" || event.payload === null) return undefined;
    const payload = event.payload as Record<string, unknown>;
    if (!isThinkingCapableModel(payload.model)) return undefined;
    // Respect the level pi resolved, so raising CHALLENGE_THINKING still works and this hook only
    // closes the gap when thinking is already meant to be off.
    if (!thinkingIsOff(context.thinkingLevel)) return undefined;

    const next = applyThinkingOff(payload, format);
    if (!announced) {
      announced = true;
      console.error(
        `[thinking-off] model=${String(payload.model)} format=${format} phase=${process.env.CHALLENGE_AGENT_PHASE ?? "unknown"}`,
      );
    }
    return next === payload ? undefined : next;
  });
}
