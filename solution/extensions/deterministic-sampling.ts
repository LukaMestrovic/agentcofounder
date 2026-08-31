import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

/**
 * Pins the sampling parameters so two runs of the same idea diverge as little as the server allows.
 *
 * Pi does not send `temperature`, `top_p`, or `seed` unless a model entry declares them, and
 * `~/.pi/agent/models.json` is untracked, so an unpinned run samples at whatever the provider
 * defaults to. GLM on Berget defaults to temperature 1, which is why two runs of one idea produced
 * different file layouts, different test counts, and — on 2026-08-24 — a repair session in one run
 * and none in the other.
 *
 * This narrows variance; it does not remove it. vLLM and SGLang batch requests together, and the
 * reduction order inside a batch depends on what else is in flight, so identical inputs can still
 * differ by a token. Treat a repeated run as "close", never as a checksum.
 */
export const DEFAULT_SEED = 20260824;

export function seedFromEnvironment(raw: string | undefined): number {
  const value = (raw ?? "").trim();
  if (value === "") return DEFAULT_SEED;
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 0) {
    throw new Error(`CHALLENGE_SEED must be a non-negative integer (got "${raw}")`);
  }
  return parsed;
}

/**
 * Greedy decoding. `top_p: 1` matters because a provider-side default below 1 still truncates the
 * distribution even at temperature 0, and the two interact differently across vLLM versions.
 */
export function applySampling(payload: Record<string, unknown>, seed: number): Record<string, unknown> {
  return { ...payload, temperature: 0, top_p: 1, seed };
}

export default function deterministicSampling(pi: ExtensionAPI) {
  const seed = seedFromEnvironment(process.env.CHALLENGE_SEED);
  let announced = false;

  pi.on("before_provider_request", (event) => {
    if (typeof event.payload !== "object" || event.payload === null) return undefined;
    const payload = event.payload as Record<string, unknown>;
    if (!announced) {
      announced = true;
      console.error(
        `[sampling] temperature=0 top_p=1 seed=${seed} phase=${process.env.CHALLENGE_AGENT_PHASE ?? "unknown"}`,
      );
    }
    return applySampling(payload, seed);
  });
}
