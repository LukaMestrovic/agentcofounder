import { describe, expect, it } from "vitest";
import { validateAppSchema } from "../src/app-schema.js";

function validSchema(): Record<string, unknown> {
  return {
    version: 1,
    product: {
      name: "Shelf Signal",
      promise: "Know where every book is",
      audience: "A private home-library owner",
      visual_direction: "Warm editorial library with tactile cards",
    },
    journeys: [{ id: "add", label: "Add a book", acceptance: "The complete book appears" }],
    data_model: {
      entities: [
        {
          name: "Book",
          fields: [
            { name: "title", type: "text", required: true },
            { name: "genre", type: "enum", required: true, options: ["Novel", "Reference"] },
          ],
        },
      ],
      persistence: "Versioned localStorage repository",
      invariants: ["Blank titles are rejected"],
    },
    architecture: {
      approach: "Domain module plus an idea-specific React interface",
      starter_changes: ["Replace the starter screen in the copied output only"],
      files: [
        { path: "src/library.ts", responsibility: "Book rules", owner: "domain" },
        { path: "src/App.tsx", responsibility: "Library interface", owner: "experience" },
        { path: "src/App.test.tsx", responsibility: "Journey tests", owner: "quality" },
      ],
    },
    tasks: [
      { agent: "domain", goal: "Implement book rules", files: ["src/library.ts"] },
      { agent: "experience", goal: "Implement the interface", files: ["src/App.tsx"] },
      { agent: "quality", goal: "Test the journeys", files: ["src/App.test.tsx"] },
    ],
    quality: { edge_cases: ["Malformed storage"], test_journeys: ["Add a complete book"] },
  };
}

describe("app schema", () => {
  it("accepts a prompt-specific architecture with isolated ownership", () => {
    expect(validateAppSchema(validSchema())).toEqual([]);
  });

  it("rejects unsafe paths, duplicate task roles, and conflicting ownership", () => {
    const schema = validSchema();
    const architecture = schema.architecture as Record<string, unknown>;
    architecture.files = [
      { path: "../app-template/src/App.tsx", responsibility: "Escape", owner: "domain" },
      { path: "src/App.tsx", responsibility: "Interface", owner: "experience" },
    ];
    schema.tasks = [
      { agent: "domain", goal: "Wrong owner", files: ["src/App.tsx"] },
      { agent: "domain", goal: "Duplicate role", files: ["src/domain.ts"] },
      { agent: "quality", goal: "Test", files: ["report.partial.json"] },
    ];
    const errors = validateAppSchema(schema);
    expect(errors.some((error) => error.includes("safe app-relative"))).toBe(true);
    expect(errors.some((error) => error.includes("task role domain is duplicated"))).toBe(true);
    expect(errors.some((error) => error.includes("architecture assigns experience"))).toBe(true);
  });

  it("requires one quality-owned TSX test so UI coverage cannot invalidate the extension", () => {
    const schema = validSchema();
    const architecture = schema.architecture as { files: Array<Record<string, unknown>> };
    architecture.files[2]!.path = "src/App.test.ts";
    const tasks = schema.tasks as Array<{ agent: string; files: string[] }>;
    tasks.find((task) => task.agent === "quality")!.files = ["src/App.test.ts"];
    expect(validateAppSchema(schema)).toContain(
      "quality must own exactly one consolidated src/**/*.test.tsx file",
    );
  });
});
