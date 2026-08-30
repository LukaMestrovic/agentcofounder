import { access, mkdir, readFile, readdir, stat, unlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  canonicalResultPath,
  resultStartCommand,
  runIdFromStartedAt,
} from "../src/result.js";
import type { RunResult } from "../src/types.js";
import { weightedTokenScore } from "../src/usage.js";

const SCRIPT_DIRECTORY = path.dirname(fileURLToPath(import.meta.url));
const REPOSITORY_ROOT = path.resolve(SCRIPT_DIRECTORY, "..");
const APPLY = process.argv.includes("--apply");
const RUN_ID_PATTERN = /\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-\d{3}Z/u;
const SKIPPED_DIRECTORIES = new Set([".git", "node_modules", "dist", "coverage"]);

interface Candidate {
  path: string;
  result: RunResult;
  runId: string;
  appDirectory?: string;
  removeAfterMigration: boolean;
}

function isChallengeResult(value: unknown): value is RunResult {
  if (typeof value !== "object" || value === null) return false;
  const candidate = value as Record<string, unknown>;
  return (
    typeof candidate.status === "string" &&
    typeof candidate.input_tokens === "number" &&
    typeof candidate.output_tokens === "number" &&
    typeof candidate.cache_read_tokens === "number" &&
    typeof candidate.model_calls === "number" &&
    Array.isArray(candidate.call_log)
  );
}

async function walk(directory: string): Promise<string[]> {
  const found: string[] = [];
  let entries;
  try {
    entries = await readdir(directory, { withFileTypes: true });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return found;
    throw error;
  }
  for (const entry of entries) {
    if (entry.isDirectory() && SKIPPED_DIRECTORIES.has(entry.name)) continue;
    const target = path.join(directory, entry.name);
    if (entry.isDirectory()) found.push(...await walk(target));
    else if (/^result.*\.json$/u.test(entry.name)) found.push(target);
  }
  return found;
}

function inferredRunId(result: Record<string, unknown>, modifiedAt: Date): string {
  if (typeof result.run_id === "string" && RUN_ID_PATTERN.test(result.run_id)) return result.run_id;
  const artifactMatch = JSON.stringify(result).match(new RegExp(`artifacts/runs/(${RUN_ID_PATTERN.source})`, "u"));
  return artifactMatch?.[1] ?? runIdFromStartedAt(modifiedAt.toISOString());
}

async function existingAppDirectory(resultPath: string): Promise<string | undefined> {
  if (path.basename(resultPath) !== "result.json") return undefined;
  const relative = path.relative(path.join(REPOSITORY_ROOT, "output"), resultPath);
  if (relative.startsWith("..") || path.isAbsolute(relative)) return undefined;
  const candidate = path.dirname(resultPath);
  try {
    await access(path.join(candidate, "package.json"));
    return candidate;
  } catch {
    return undefined;
  }
}

function shouldRemoveLegacyCopy(resultPath: string): boolean {
  const relative = path.relative(REPOSITORY_ROOT, resultPath);
  if (!relative.includes(path.sep)) return /^result.*\.json$/u.test(relative);
  if (relative.split(path.sep).join("/").startsWith("benchmark/results/")) return true;
  if (/^artifacts\/runs\/[^/]+\/result\.json$/u.test(relative.split(path.sep).join("/"))) return true;
  return /^result .+\.json$/u.test(path.basename(resultPath));
}

function sameRun(left: RunResult, right: RunResult): boolean {
  return (
    left.status === right.status &&
    left.model_calls === right.model_calls &&
    left.input_tokens === right.input_tokens &&
    left.output_tokens === right.output_tokens &&
    left.cache_read_tokens === right.cache_read_tokens &&
    left.total_tokens === right.total_tokens
  );
}

async function readCandidate(resultPath: string): Promise<Candidate | undefined> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(await readFile(resultPath, "utf8"));
  } catch {
    return undefined;
  }
  if (!isChallengeResult(parsed)) return undefined;
  const modifiedAt = (await stat(resultPath)).mtime;
  const runId = inferredRunId(parsed as unknown as Record<string, unknown>, modifiedAt);
  const {
    run_id: _oldRunId,
    started_at: _oldStartedAt,
    weighted_score: _oldWeightedScore,
    ...originalResult
  } = parsed;
  const enriched: RunResult = {
    run_id: runId,
    weighted_score: weightedTokenScore(parsed),
    ...originalResult,
  };
  return {
    path: resultPath,
    result: enriched,
    runId,
    appDirectory: await existingAppDirectory(resultPath),
    removeAfterMigration: shouldRemoveLegacyCopy(resultPath),
  };
}

async function main(): Promise<void> {
  const roots = [
    path.join(REPOSITORY_ROOT, "results", "runs"),
    path.join(REPOSITORY_ROOT, "output"),
    path.join(REPOSITORY_ROOT, "artifacts", "runs"),
    path.join(REPOSITORY_ROOT, "benchmark", "results"),
  ];
  const rootFiles = (await readdir(REPOSITORY_ROOT, { withFileTypes: true }))
    .filter((entry) => entry.isFile() && /^result.*\.json$/u.test(entry.name))
    .map((entry) => path.join(REPOSITORY_ROOT, entry.name));
  const paths = [...rootFiles, ...(await Promise.all(roots.map(walk))).flat()].sort();
  const candidates = (await Promise.all(paths.map(readCandidate))).filter(
    (candidate): candidate is Candidate => candidate !== undefined,
  );
  const byRun = new Map<string, Candidate[]>();
  for (const candidate of candidates) {
    const matches = byRun.get(candidate.runId) ?? [];
    if (matches.some((match) => !sameRun(match.result, candidate.result))) {
      throw new Error(`Conflicting result files claim run ${candidate.runId}`);
    }
    matches.push(candidate);
    byRun.set(candidate.runId, matches);
  }

  for (const [runId, matches] of [...byRun].sort(([left], [right]) => left.localeCompare(right))) {
    const savedPath = canonicalResultPath(REPOSITORY_ROOT, runId);
    const preferred = matches.find((candidate) => candidate.appDirectory) ?? matches[0];
    const savedResult = {
      ...preferred.result,
      start_command: preferred.appDirectory
        ? resultStartCommand(path.dirname(savedPath), preferred.appDirectory)
        : preferred.result.start_command,
    };
    console.log(`${APPLY ? "write" : "would write"} ${path.relative(REPOSITORY_ROOT, savedPath)}`);
    if (APPLY) {
      await mkdir(path.dirname(savedPath), { recursive: true });
      await writeFile(savedPath, `${JSON.stringify(savedResult, null, 2)}\n`, "utf8");
    }
    for (const candidate of matches) {
      if (candidate.removeAfterMigration) {
        console.log(`${APPLY ? "remove" : "would remove"} ${path.relative(REPOSITORY_ROOT, candidate.path)}`);
        if (APPLY) await unlink(candidate.path);
      } else if (APPLY) {
        await writeFile(candidate.path, `${JSON.stringify(candidate.result, null, 2)}\n`, "utf8");
      }
    }
  }

  console.log(`${APPLY ? "Organized" : "Found"} ${byRun.size} unique runs from ${candidates.length} result files.`);
  if (!APPLY) console.log("Run again with --apply to write the canonical store and remove legacy loose copies.");
}

await main();
