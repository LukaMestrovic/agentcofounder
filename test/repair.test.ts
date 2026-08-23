import { describe, expect, it } from "vitest";
import type { AppSchema } from "../src/app-schema.js";
import { buildRepairBrief, selectRepairFiles } from "../src/repair.js";
import type { AppVerification } from "../src/types.js";

const schema: AppSchema = {
  version: 1,
  product: {
    name: "General Tool",
    promise: "Help one user complete a workflow",
    audience: "A single local user",
    visual_direction: "Calm editorial interface",
  },
  journeys: [{ id: "complete", label: "Complete work", acceptance: "The state updates" }],
  data_model: {
    entities: [{ name: "Record", fields: [{ name: "name", type: "text", required: true }] }],
    persistence: "localStorage",
    invariants: ["Names are required"],
  },
  architecture: {
    approach: "Domain module and custom React interface",
    starter_changes: ["Replace starter UI"],
    files: [
      { path: "src/domain.ts", responsibility: "Rules", owner: "domain" },
      { path: "src/App.tsx", responsibility: "Interface", owner: "experience" },
      { path: "src/styles.css", responsibility: "Visual design", owner: "experience" },
      { path: "src/general.test.tsx", responsibility: "Journey checks", owner: "quality" },
    ],
  },
  tasks: [
    { agent: "domain", goal: "Implement rules", files: ["src/domain.ts"] },
    { agent: "experience", goal: "Implement UI", files: ["src/App.tsx", "src/styles.css"] },
    { agent: "quality", goal: "Implement tests", files: ["src/general.test.tsx"] },
  ],
  quality: { edge_cases: ["Malformed storage"], test_journeys: ["Complete work"] },
};

function failedVerification(
  check: "structure" | "test" | "build" | "dev",
  implicatedFiles: string[],
): AppVerification {
  return {
    passed: false,
    checks: [],
    failures: [{ check, summary: "Failed", excerpt: "Diagnostic", implicated_files: implicatedFiles }],
  };
}

describe("repair scoping", () => {
  it("selects test ownership and only schema-declared implicated files", () => {
    const selected = selectRepairFiles(
      schema,
      failedVerification("test", ["src/App.tsx", "../outside.ts", "src/unknown.ts"]),
      1,
    );
    expect(selected.map((file) => file.path)).toEqual(["src/App.tsx", "src/general.test.tsx"]);
  });

  it("uses experience files for startup failures and widens the second repair", () => {
    expect(selectRepairFiles(schema, failedVerification("dev", []), 1).map((file) => file.path)).toEqual([
      "src/App.tsx",
      "src/styles.css",
    ]);
    expect(selectRepairFiles(schema, failedVerification("dev", []), 2)).toEqual(schema.architecture.files);
  });

  it("builds a compact repair contract without the raw product idea", () => {
    const brief = buildRepairBrief(schema, failedVerification("build", ["src/domain.ts"]), 1);
    expect(brief.attempt).toBe(1);
    expect(brief.invariants).toEqual(["Names are required"]);
    expect(brief.candidate_files.map((file) => file.path)).toEqual(["src/domain.ts"]);
    expect(brief).not.toHaveProperty("data_model");
    expect(brief).not.toHaveProperty("tasks");
  });
});
