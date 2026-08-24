import { describe, expect, it } from "vitest";
import type { AppSchema } from "../src/app-schema.js";
import {
  SCAFFOLD_PATH,
  scaffoldApiSummary,
  scaffoldDataLayer,
  scaffoldPath,
} from "../src/scaffold-data-layer.js";

function schemaWith(overrides: Partial<AppSchema["data_model"]>, files: AppSchema["architecture"]["files"] = []): AppSchema {
  return {
    version: 1,
    product: { name: "Shelf Ledger", promise: "p", audience: "a", visual_direction: "v" },
    journeys: [{ id: "j1", label: "l", acceptance: "a" }],
    data_model: {
      entities: [
        {
          name: "Book",
          fields: [
            { name: "title", type: "text", required: true },
            { name: "category", type: "enum", required: true, options: ["novel", "cookbook"] },
            { name: "borrower", type: "text", required: false },
          ],
        },
      ],
      persistence: "localStorage under key 'shelf-ledger-books'",
      invariants: [],
      ...overrides,
    },
    architecture: {
      approach: "a",
      starter_changes: [],
      files: files.length > 0 ? files : [{ path: "src/App.tsx", responsibility: "r", owner: "experience" }],
    },
    tasks: [],
    quality: { edge_cases: [], test_journeys: ["t"] },
  };
}

describe("data layer scaffolding", () => {
  it("derives types, a storage key, guards, and record helpers from the schema", () => {
    const file = scaffoldDataLayer(schemaWith({}));
    expect(file?.path).toBe(SCAFFOLD_PATH);
    const contents = file?.contents ?? "";
    expect(contents).toContain('export const bookCategoryOptions = ["novel", "cookbook"] as const;');
    expect(contents).toContain("category: (typeof bookCategoryOptions)[number];");
    expect(contents).toContain("borrower?: string;");
    expect(contents).toContain('export const bookStorageKey = "shelf-ledger-books";');
    for (const helper of ["isBook", "loadBooks", "saveBooks", "addBook", "updateBook", "removeBook"]) {
      expect(contents).toContain(`export function ${helper}`);
    }
  });

  it("skips ideas that do not persist a record collection in the browser", () => {
    expect(scaffoldDataLayer(schemaWith({ persistence: "in-memory session state only" }))).toBeUndefined();
  });

  it("keeps a planner-declared path free by falling back to another file name", () => {
    const schema = schemaWith({}, [
      { path: "src/store.ts", responsibility: "r", owner: "domain" },
      { path: "src/App.tsx", responsibility: "r", owner: "experience" },
    ]);
    expect(scaffoldPath(schema)).toBe("src/data-store.ts");
    expect(scaffoldDataLayer(schema)?.path).toBe("src/data-store.ts");
  });

  it("summarizes the generated API with literal enum unions for the generator prompt", () => {
    const schema = schemaWith({});
    const file = scaffoldDataLayer(schema);
    const summary = scaffoldApiSummary(schema, file!);
    expect(summary).toContain("src/store.ts");
    expect(summary).toContain('category: "novel" | "cookbook"');
    expect(summary).toContain("- loadBooks(): Book[]");
  });
});
