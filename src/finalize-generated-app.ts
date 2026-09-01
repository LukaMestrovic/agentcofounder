import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import type { AppSchema } from "./app-schema.js";
import type { AppVerification, PartialRunResult } from "./types.js";

const ENTRY_ADAPTER = `import { StrictMode, type ComponentType } from "react";
import { createRoot } from "react-dom/client";
import * as AppModule from "./App.js";
import "./design-system.css";
import "./styles.css";

const exports = AppModule as { App?: ComponentType; default?: ComponentType };
const App = exports.App ?? exports.default;
if (!App) throw new Error("App.tsx must export a React component");

const root = document.getElementById("root");
if (!root) throw new Error("Missing application root");

createRoot(root).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
`;

const TEST_SETUP = `import "@testing-library/jest-dom/vitest";
import { cleanup } from "@testing-library/react";
import { afterEach } from "vitest";

afterEach(cleanup);
`;

export async function normalizeGeneratedEntry(appDirectory: string): Promise<void> {
  const appSource = await readFile(path.join(appDirectory, "src", "App.tsx"), "utf8");
  if (!/export\s+(?:default\s+)?(?:function|const|class)\s+App\b|export\s+default\s+/u.test(appSource)) {
    throw new Error("Generated src/App.tsx does not export an application component");
  }
  await writeFile(path.join(appDirectory, "src", "main.tsx"), ENTRY_ADAPTER, "utf8");
}

export async function prepareGeneratedTestHarness(appDirectory: string): Promise<void> {
  await writeFile(path.join(appDirectory, "src", "test", "setup.ts"), TEST_SETUP, "utf8");
}

export function missingPartialReport(partial: PartialRunResult): boolean {
  return partial.summary === "The harness did not produce a valid report.partial.json file.";
}

export function fallbackPartialResult(schema: AppSchema, verification: AppVerification): PartialRunResult {
  if (!verification.passed) throw new Error("Cannot create a successful fallback report before verification passes");
  return {
    status: "success",
    app_url: "http://localhost:3000",
    start_command: "npm run dev",
    summary: `${schema.product.name}: ${schema.product.promise}`,
    implemented_features: schema.journeys.map((journey) => journey.label),
    assumptions: [
      `Built for ${schema.product.audience}.`,
      `Persistence decision: ${schema.data_model.persistence}`,
    ],
    tests_run: [
      {
        command: "npm test",
        journey: `Generated journey suite passed: ${schema.quality.test_journeys.join("; ")}`,
        result: "passed",
      },
    ],
  };
}

export function fallbackUnverifiedPartialResult(
  schema: AppSchema,
  verification: AppVerification,
): PartialRunResult {
  const failedChecks = verification.checks
    .filter((check) => check.result === "failed")
    .map((check) => check.command)
    .join(", ");
  return {
    status: "partial",
    app_url: "http://localhost:3000",
    start_command: "npm run dev",
    summary: `${schema.product.name}: generation completed, but independent verification did not pass.`,
    implemented_features: schema.journeys.map((journey) => journey.label),
    assumptions: [
      `Built for ${schema.product.audience}.`,
      `Persistence decision: ${schema.data_model.persistence}`,
    ],
    tests_run: [
      {
        command: "npm test",
        journey: `Generated journey verification failed: ${schema.quality.test_journeys.join("; ")}. Failed checks: ${failedChecks || "unknown"}`,
        result: "failed",
      },
    ],
  };
}

export function finalizeVerifiedPartialResult(
  partial: PartialRunResult,
  schema: AppSchema,
  verification: AppVerification,
): PartialRunResult {
  if (!verification.passed) return partial;

  const verifiedTest: PartialRunResult["tests_run"][number] = {
    command: "npm test",
    journey: `Verified generated journey suite: ${schema.quality.test_journeys.join("; ")}`,
    result: "passed",
  };
  if (missingPartialReport(partial)) return fallbackPartialResult(schema, verification);

  return {
    ...partial,
    status: "success",
    // The runner owns this field. Model-written bookkeeping can be stale or malformed,
    // while verification above has just executed the generated suite successfully.
    tests_run: [verifiedTest],
  };
}

export async function writePartialReport(appDirectory: string, partial: PartialRunResult): Promise<void> {
  await writeFile(path.join(appDirectory, "report.partial.json"), `${JSON.stringify(partial, null, 2)}\n`, "utf8");
}
