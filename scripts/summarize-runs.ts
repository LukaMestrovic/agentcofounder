import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { RunResult } from "../src/types.js";
import { weightedTokenScore } from "../src/usage.js";

const SCRIPT_DIRECTORY = path.dirname(fileURLToPath(import.meta.url));
const REPOSITORY_ROOT = path.resolve(SCRIPT_DIRECTORY, "..");

interface RunRow {
  runId: string;
  status: string;
  calls: number;
  score: number;
  attempts: number;
  repairs: number;
  firstAttemptClean: boolean;
}

async function listDirectories(directory: string): Promise<string[]> {
  try {
    return (await readdir(directory, { withFileTypes: true }))
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name);
  } catch {
    return [];
  }
}

async function readResult(file: string): Promise<RunResult | undefined> {
  try {
    return JSON.parse(await readFile(file, "utf8")) as RunResult;
  } catch {
    return undefined;
  }
}

/**
 * A run that failed verification once and was repaired is not the same event as a run that never
 * built. Counting attempts separately from status keeps a recovered run legible as a recovery.
 */
async function auditShape(runId: string): Promise<{ attempts: number; repairs: number }> {
  const artifactDirectory = path.join(REPOSITORY_ROOT, "artifacts", "runs", runId);
  const attempts = (await listDirectories(path.join(artifactDirectory, "verification"))).filter((name) =>
    name.startsWith("attempt-"),
  ).length;
  let entries: string[] = [];
  try {
    entries = await readdir(artifactDirectory);
  } catch {
    entries = [];
  }
  return { attempts, repairs: entries.filter((name) => /^repair-\d+\.events\.jsonl$/u.test(name)).length };
}

async function collect(): Promise<RunRow[]> {
  const canonical = path.join(REPOSITORY_ROOT, "results", "runs");
  const seen = new Set<string>();
  const rows: RunRow[] = [];
  for (const source of [canonical, path.join(REPOSITORY_ROOT, "artifacts", "runs")]) {
    for (const runId of await listDirectories(source)) {
      if (seen.has(runId)) continue;
      const result = await readResult(path.join(source, runId, "result.json"));
      if (!result) continue;
      seen.add(runId);
      const { attempts, repairs } = await auditShape(runId);
      rows.push({
        runId,
        status: result.status,
        calls: result.model_calls,
        score: result.weighted_score ?? weightedTokenScore(result),
        attempts,
        repairs,
        firstAttemptClean: repairs === 0 && result.status === "success",
      });
    }
  }
  return rows.sort((left, right) => left.runId.localeCompare(right.runId));
}

function pad(value: string, width: number): string {
  return value.length >= width ? value : `${value}${" ".repeat(width - value.length)}`;
}

function padStart(value: string, width: number): string {
  return value.length >= width ? value : `${" ".repeat(width - value.length)}${value}`;
}

const rows = await collect();
console.log(
  `${pad("run", 26)}${pad("status", 9)}${padStart("calls", 6)}${padStart("score", 12)}${padStart("attempts", 10)}${padStart("repairs", 9)}  note`,
);
for (const row of rows) {
  const note = row.firstAttemptClean
    ? "clean first pass"
    : row.status === "success"
      ? `recovered after ${row.repairs} repair${row.repairs === 1 ? "" : "s"}`
      : row.calls === 0 || row.calls === 1
        ? "never generated"
        : "verification never passed";
  console.log(
    `${pad(row.runId, 26)}${pad(row.status, 9)}${padStart(String(row.calls), 6)}${padStart(row.score.toLocaleString("en-US", { minimumFractionDigits: 1, maximumFractionDigits: 1 }), 12)}${padStart(String(row.attempts), 10)}${padStart(String(row.repairs), 9)}  ${note}`,
  );
}

const successes = rows.filter((row) => row.status === "success");
if (successes.length > 0) {
  const best = successes.reduce((left, right) => (right.score < left.score ? right : left));
  console.log(`\n${successes.length}/${rows.length} succeeded. Best: ${best.runId} at ${best.score.toLocaleString("en-US")}.`);
}
