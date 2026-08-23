import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { AppSchema } from "../src/app-schema.js";
import {
  fallbackPartialResult,
  fallbackUnverifiedPartialResult,
  finalizeVerifiedPartialResult,
  normalizeGeneratedEntry,
  prepareGeneratedTestHarness,
} from "../src/finalize-generated-app.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true })));
});

describe("generated app finalization", () => {
  it("adapts either named or default App exports without touching the template", async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "agent-cofounder-finalize-"));
    temporaryDirectories.push(directory);
    await mkdir(path.join(directory, "src"));
    await writeFile(path.join(directory, "src", "App.tsx"), "export default function App() { return null; }\n");
    await normalizeGeneratedEntry(directory);
    const entry = await readFile(path.join(directory, "src", "main.tsx"), "utf8");
    expect(entry).toContain("exports.App ?? exports.default");
  });

  it("configures deterministic React cleanup in the generated copy", async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "agent-cofounder-test-setup-"));
    temporaryDirectories.push(directory);
    await mkdir(path.join(directory, "src", "test"), { recursive: true });
    await prepareGeneratedTestHarness(directory);
    const setup = await readFile(path.join(directory, "src", "test", "setup.ts"), "utf8");
    expect(setup).toContain("afterEach(cleanup)");
  });

  it("creates a truthful report only from a passing independent verification", () => {
    const schema = {
      product: { name: "Tool", promise: "Help", audience: "One user" },
      data_model: { persistence: "localStorage" },
      journeys: [{ label: "Add records" }],
      quality: { test_journeys: ["Add a record"] },
    } as AppSchema;
    expect(() => fallbackPartialResult(schema, { passed: false, checks: [], failures: [] })).toThrow("verification passes");
    expect(fallbackPartialResult(schema, { passed: true, checks: [], failures: [] })).toMatchObject({
      status: "success",
      implemented_features: ["Add records"],
      tests_run: [{ result: "passed" }],
    });
  });

  it("uses passing runner verification as the canonical test record", () => {
    const schema = {
      product: { name: "Tool", promise: "Help", audience: "One user" },
      data_model: { persistence: "localStorage" },
      journeys: [{ label: "Add records" }],
      quality: { test_journeys: ["Add a record", "Persist it"] },
    } as AppSchema;
    const partial = {
      status: "partial" as const,
      app_url: "http://localhost:3000",
      start_command: "npm run dev",
      summary: "A useful generated tool.",
      implemented_features: ["Custom feature"],
      assumptions: ["Local only"],
      tests_run: [],
    };

    expect(finalizeVerifiedPartialResult(partial, schema, { passed: false, checks: [], failures: [] })).toBe(partial);
    expect(finalizeVerifiedPartialResult(partial, schema, { passed: true, checks: [], failures: [] })).toEqual({
      ...partial,
      status: "success",
      tests_run: [{
        command: "npm test",
        journey: "Verified generated journey suite: Add a record; Persist it",
        result: "passed",
      }],
    });
  });

  it("reports exhausted verification as partial without model-authored bookkeeping", () => {
    const schema = {
      product: { name: "Tool", promise: "Help", audience: "One user" },
      data_model: { persistence: "localStorage" },
      journeys: [{ label: "Add records" }],
      quality: { test_journeys: ["Add a record"] },
    } as AppSchema;
    const partial = fallbackUnverifiedPartialResult(schema, {
      passed: false,
      checks: [{ command: "npm run build", journey: "Build", result: "failed" }],
      failures: [],
    });
    expect(partial.status).toBe("partial");
    expect(partial.tests_run).toEqual([expect.objectContaining({ result: "failed" })]);
  });
});
