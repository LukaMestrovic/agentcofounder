import { writeFile } from "node:fs/promises";
import path from "node:path";
import type { AppSchema } from "./app-schema.js";

type Entity = AppSchema["data_model"]["entities"][number];
type Field = Entity["fields"][number];

export interface ScaffoldFile {
  path: string;
  contents: string;
}

export const SCAFFOLD_PATH = "src/store.ts";
const FALLBACK_SCAFFOLD_PATH = "src/data-store.ts";

/**
 * The generated collection store only fits ideas that keep records in browser storage.
 * Calculators and timers hold transient state instead, so they are left to the model.
 */
export function usesBrowserCollection(schema: AppSchema): boolean {
  return /local\s?storage|session\s?storage|browser/iu.test(schema.data_model.persistence);
}

export function scaffoldPath(schema: AppSchema): string {
  const declared = new Set(schema.architecture.files.map((file) => path.normalize(file.path)));
  return declared.has(path.normalize(SCAFFOLD_PATH)) ? FALLBACK_SCAFFOLD_PATH : SCAFFOLD_PATH;
}

function pascalCase(value: string): string {
  const words = value.replace(/[^A-Za-z0-9]+/gu, " ").trim().split(" ").filter(Boolean);
  const joined = words.map((word) => word.charAt(0).toUpperCase() + word.slice(1)).join("");
  return /^[A-Za-z]/u.test(joined) ? joined : `Record${joined}`;
}

function camelCase(value: string): string {
  const pascal = pascalCase(value);
  return pascal.charAt(0).toLowerCase() + pascal.slice(1);
}

function pluralize(value: string): string {
  if (/(s|x|z|ch|sh)$/iu.test(value)) return `${value}es`;
  if (/[^aeiou]y$/iu.test(value)) return `${value.slice(0, -1)}ies`;
  return `${value}s`;
}

function slug(value: string): string {
  return value.replace(/[^A-Za-z0-9]+/gu, "-").replace(/^-+|-+$/gu, "").toLowerCase() || "records";
}

function quotedKey(persistence: string): string | undefined {
  const match = /['"`]([A-Za-z0-9._:-]{3,})['"`]/u.exec(persistence);
  return match?.[1];
}

interface EntityNames {
  type: string;
  singular: string;
  plural: string;
  storageKey: string;
}

function entityNames(schema: AppSchema, entity: Entity, index: number): EntityNames {
  const type = pascalCase(entity.name);
  const singular = camelCase(entity.name);
  const plural = pluralize(pascalCase(entity.name));
  const explicitKey = schema.data_model.entities.length === 1 ? quotedKey(schema.data_model.persistence) : undefined;
  const storageKey = explicitKey ?? `${slug(schema.product.name)}-${slug(pluralize(entity.name))}-${index + 1}`;
  return { type, singular, plural, storageKey };
}

function usableFields(entity: Entity): Field[] {
  const seen = new Set<string>(["id"]);
  return entity.fields.filter((field) => {
    const name = camelCase(field.name);
    if (name === "" || seen.has(name)) return false;
    seen.add(name);
    return true;
  });
}

function fieldIdentifier(field: Field): string {
  return camelCase(field.name);
}

function optionsIdentifier(names: EntityNames, field: Field): string {
  return `${names.singular}${pascalCase(field.name)}Options`;
}

function enumTypeIdentifier(names: EntityNames, field: Field): string {
  return `${names.type}${pascalCase(field.name)}`;
}

function enumCoercionIdentifier(names: EntityNames, field: Field): string {
  return `as${names.type}${pascalCase(field.name)}`;
}

function fieldType(names: EntityNames, field: Field): string {
  if (field.type === "number") return "number";
  if (field.type === "boolean") return "boolean";
  if (field.type === "enum") return enumTypeIdentifier(names, field);
  return "string";
}

function invalidCheck(names: EntityNames, field: Field): string {
  const reference = `record.${fieldIdentifier(field)}`;
  if (field.type === "number") return `typeof ${reference} !== "number" || !Number.isFinite(${reference})`;
  if (field.type === "boolean") return `typeof ${reference} !== "boolean"`;
  if (field.type === "enum") {
    const options = optionsIdentifier(names, field);
    return `!${options}.includes(${reference} as ${enumTypeIdentifier(names, field)})`;
  }
  return `typeof ${reference} !== "string"`;
}

function guardLine(names: EntityNames, field: Field): string {
  const check = invalidCheck(names, field);
  if (field.required) return `  if (${check}) return false;`;
  return `  if (record.${fieldIdentifier(field)} !== undefined && (${check})) return false;`;
}

function entitySource(schema: AppSchema, entity: Entity, index: number): string {
  const names = entityNames(schema, entity, index);
  const fields = usableFields(entity);
  // A bare string-literal union rejects the `string` that a <select> onChange hands back, which
  // cost two repair sessions to a `tsc --noEmit` failure on 2026-08-24. Exporting the alias and a
  // total coercion beside it makes narrowing a one-token call instead of a type puzzle.
  const enumConstants = fields
    .filter((field) => field.type === "enum")
    .flatMap((field) => {
      const options = optionsIdentifier(names, field);
      const alias = enumTypeIdentifier(names, field);
      const coercion = enumCoercionIdentifier(names, field);
      return [
        `export const ${options} = [${(field.options ?? [])
          .map((option) => JSON.stringify(option))
          .join(", ")}] as const;`,
        `export type ${alias} = (typeof ${options})[number];`,
        `export function ${coercion}(value: string): ${alias} {`,
        `  return ${options}.includes(value as ${alias}) ? (value as ${alias}) : ${options}[0];`,
        "}",
      ];
    });

  const typeMembers = fields.map(
    (field) => `  ${fieldIdentifier(field)}${field.required ? "" : "?"}: ${fieldType(names, field)};`,
  );

  return [
    ...enumConstants,
    enumConstants.length > 0 ? "" : undefined,
    `export type ${names.type} = {`,
    "  id: string;",
    ...typeMembers,
    "};",
    "",
    `export const ${names.singular}StorageKey = ${JSON.stringify(names.storageKey)};`,
    "",
    `export function is${names.type}(value: unknown): value is ${names.type} {`,
    '  if (typeof value !== "object" || value === null) return false;',
    "  const record = value as Record<string, unknown>;",
    '  if (typeof record.id !== "string" || record.id === "") return false;',
    ...fields.map((field) => guardLine(names, field)),
    "  return true;",
    "}",
    "",
    `export function load${names.plural}(): ${names.type}[] {`,
    "  try {",
    `    const raw = window.localStorage.getItem(${names.singular}StorageKey);`,
    "    if (raw === null) return [];",
    "    const parsed: unknown = JSON.parse(raw);",
    `    return Array.isArray(parsed) ? parsed.filter(is${names.type}) : [];`,
    "  } catch {",
    "    return [];",
    "  }",
    "}",
    "",
    `export function save${names.plural}(items: readonly ${names.type}[]): void {`,
    "  try {",
    `    window.localStorage.setItem(${names.singular}StorageKey, JSON.stringify(items));`,
    "  } catch {",
    "    // Storage can be unavailable or full; the in-memory collection stays authoritative.",
    "  }",
    "}",
    "",
    `export function add${names.type}(items: readonly ${names.type}[], input: Omit<${names.type}, "id">): ${names.type}[] {`,
    "  return [...items, { ...input, id: createId() }];",
    "}",
    "",
    `export function update${names.type}(`,
    `  items: readonly ${names.type}[],`,
    "  id: string,",
    `  changes: Partial<Omit<${names.type}, "id">>,`,
    `): ${names.type}[] {`,
    "  return items.map((item) => (item.id === id ? { ...item, ...changes } : item));",
    "}",
    "",
    `export function remove${names.type}(items: readonly ${names.type}[], id: string): ${names.type}[] {`,
    "  return items.filter((item) => item.id !== id);",
    "}",
  ]
    .filter((line): line is string => line !== undefined)
    .join("\n");
}

export function scaffoldDataLayer(schema: AppSchema): ScaffoldFile | undefined {
  if (!usesBrowserCollection(schema)) return undefined;
  const entities = schema.data_model.entities.filter((entity) => usableFields(entity).length > 0);
  if (entities.length === 0) return undefined;

  const header = [
    "// Generated by the challenge runner from app-schema.json. This file is runner-owned.",
    "",
    "export function createId(): string {",
    "  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;",
    "}",
  ].join("\n");

  const contents = [header, ...entities.map((entity, index) => entitySource(schema, entity, index))].join("\n\n");
  return { path: scaffoldPath(schema), contents: `${contents}\n` };
}

function sampleValue(names: EntityNames, field: Field): string {
  switch (field.type) {
    case "number":
      return "1";
    case "boolean":
      return "true";
    case "enum":
      return `${optionsIdentifier(names, field)}[0]`;
    default:
      return JSON.stringify(`${fieldIdentifier(field)}-value`);
  }
}

function alternateValue(names: EntityNames, field: Field): string {
  switch (field.type) {
    case "number":
      return "2";
    case "boolean":
      return "false";
    case "enum": {
      const optionCount = (field.options ?? []).length;
      return `${optionsIdentifier(names, field)}[${optionCount > 1 ? 1 : 0}]`;
    }
    case "date":
      return JSON.stringify("2001-02-03");
    default:
      return JSON.stringify(`${fieldIdentifier(field)}-updated`);
  }
}

interface EntityTest {
  imports: string[];
  body: string;
}

function entityTest(schema: AppSchema, entity: Entity, index: number): EntityTest {
  const names = entityNames(schema, entity, index);
  const fields = usableFields(entity);
  const [mutable] = fields;
  if (!mutable) return { imports: [], body: "" };
  const requiredFields = fields.filter((field) => field.required);

  const enumImports = new Set<string>();
  for (const field of [...requiredFields, mutable]) {
    if (field.type === "enum") enumImports.add(optionsIdentifier(names, field));
  }

  const imports = [
    `add${names.type}`,
    `update${names.type}`,
    `remove${names.type}`,
    `is${names.type}`,
    `load${names.plural}`,
    `save${names.plural}`,
    ...enumImports,
  ];

  const inputLiteral =
    requiredFields.length === 0
      ? "{}"
      : `{ ${requiredFields.map((field) => `${fieldIdentifier(field)}: ${sampleValue(names, field)}`).join(", ")} }`;
  const mutableId = fieldIdentifier(mutable);
  const mutableAlt = alternateValue(names, mutable);

  const body = [
    `describe(${JSON.stringify(`${names.type} store`)}, () => {`,
    "  it(\"adds, persists, updates, and removes a record\", () => {",
    `    const created = add${names.type}([], ${inputLiteral});`,
    "    expect(created).toHaveLength(1);",
    '    expect(typeof created[0].id).toBe("string");',
    "    expect(created[0].id.length).toBeGreaterThan(0);",
    `    save${names.plural}(created);`,
    `    expect(load${names.plural}()).toHaveLength(1);`,
    `    const changed = update${names.type}(created, created[0].id, { ${mutableId}: ${mutableAlt} });`,
    `    expect(changed[0].${mutableId}).toBe(${mutableAlt});`,
    `    expect(remove${names.type}(changed, created[0].id)).toEqual([]);`,
    "  });",
    "",
    "  it(\"rejects malformed values and starts from an empty collection\", () => {",
    `    expect(is${names.type}(null)).toBe(false);`,
    `    expect(is${names.type}({})).toBe(false);`,
    `    expect(load${names.plural}()).toEqual([]);`,
    "  });",
    "});",
  ].join("\n");

  return { imports, body };
}

/**
 * The store helpers are deterministic, so their unit tests are too. Generating them here removes a
 * large slice of the generator's output tokens and guarantees the suite the runner requires already
 * passes, which is the failure class that forced repair sessions in the earlier attempt.
 */
export function scaffoldDataLayerTests(schema: AppSchema, storeFile: ScaffoldFile): ScaffoldFile | undefined {
  if (!usesBrowserCollection(schema)) return undefined;
  const entities = schema.data_model.entities.filter((entity) => usableFields(entity).length > 0);
  if (entities.length === 0) return undefined;

  const importPath = `./${path.basename(storeFile.path).replace(/\.ts$/u, "")}`;
  const tests = entities.map((entity, index) => entityTest(schema, entity, index));
  const importNames = [...new Set(tests.flatMap((test) => test.imports))];

  const contents = [
    "// Generated by the challenge runner from app-schema.json. This file is runner-owned.",
    "",
    "import {",
    ...importNames.map((name) => `  ${name},`),
    `} from ${JSON.stringify(importPath)};`,
    "",
    "beforeEach(() => {",
    "  localStorage.clear();",
    "});",
    "",
    tests.map((test) => test.body).join("\n\n"),
  ].join("\n");

  return { path: storeFile.path.replace(/\.ts$/u, ".test.ts"), contents: `${contents}\n` };
}

function summaryFieldType(names: EntityNames, field: Field): string {
  if (field.type !== "enum") return fieldType(names, field);
  // Spelled out rather than named so the generator sees the permitted values inline.
  return (field.options ?? []).map((option) => JSON.stringify(option)).join(" | ");
}

function entitySummary(schema: AppSchema, entity: Entity, index: number): string[] {
  const names = entityNames(schema, entity, index);
  const fields = usableFields(entity);
  const members = fields
    .map((field) => `${fieldIdentifier(field)}${field.required ? "" : "?"}: ${summaryFieldType(names, field)}`)
    .join("; ");
  return [
    ...fields
      .filter((field) => field.type === "enum")
      .flatMap((field) => [
        `- const ${optionsIdentifier(names, field)}: readonly [${(field.options ?? [])
          .map((option) => JSON.stringify(option))
          .join(", ")}]`,
        `- type ${enumTypeIdentifier(names, field)} = ${summaryFieldType(names, field)}`,
        `- ${enumCoercionIdentifier(names, field)}(value: string): ${enumTypeIdentifier(names, field)}`,
      ]),
    `- type ${names.type} = { id: string; ${members} }`,
    `- const ${names.singular}StorageKey: string`,
    `- is${names.type}(value: unknown): value is ${names.type}`,
    `- load${names.plural}(): ${names.type}[]  // parses storage, drops malformed records, never throws`,
    `- save${names.plural}(items: readonly ${names.type}[]): void  // never throws`,
    `- add${names.type}(items, input: Omit<${names.type}, "id">): ${names.type}[]  // assigns the id`,
    `- update${names.type}(items, id, changes: Partial<Omit<${names.type}, "id">>): ${names.type}[]`,
    `- remove${names.type}(items, id): ${names.type}[]`,
  ];
}

export function scaffoldApiSummary(schema: AppSchema, file: ScaffoldFile, testFile?: ScaffoldFile): string {
  const importPath = `./${path.basename(file.path).replace(/\.ts$/u, "")}`;
  const entities = schema.data_model.entities.filter((entity) => usableFields(entity).length > 0);
  const lines = [
    `## Runner-generated data layer (\`${file.path}\`)`,
    "",
    `This file already exists and is not writable. Import from \`${importPath}\` instead of re-declaring entity`,
    "types, storage keys, JSON parsing, id generation, or add/update/remove logic. All helpers are pure and",
    "return new arrays; call the save helper yourself when a collection changes. Available exports:",
    "",
    "```ts",
    "- createId(): string",
    ...entities.flatMap((entity, index) => entitySummary(schema, entity, index)),
    "```",
    "",
    "Product-specific rules (filters, derived counts, state transitions, validation messages) are yours to write",
    "on top of these imports.",
  ];
  const enumFields = entities.flatMap((entity, index) => {
    const names = entityNames(schema, entity, index);
    return usableFields(entity)
      .filter((field) => field.type === "enum")
      .map((field) => ({ names, field }));
  });
  if (enumFields.length > 0) {
    lines.push(
      "",
      "Enum fields are string-literal unions, so a raw `string` from a `<select>`, an input, or `useState<string>`",
      "will not type-check. Type the state with the exported alias and wrap every incoming value in the matching",
      "`as...` helper, which is total and falls back to the first option:",
      "",
      "```ts",
      ...enumFields.slice(0, 2).map(({ names, field }) => {
        const alias = enumTypeIdentifier(names, field);
        return `const [${fieldIdentifier(field)}, set${pascalCase(field.name)}] = useState<${alias}>(${optionsIdentifier(names, field)}[0]);\n` +
          `onChange={(event) => set${pascalCase(field.name)}(${enumCoercionIdentifier(names, field)}(event.target.value))}`;
      }),
      "```",
      "",
      "`tsc --noEmit` runs as part of the production build, so an unnarrowed enum assignment fails the whole run.",
    );
  }
  if (testFile) {
    lines.push(
      "",
      `Persistence and domain unit tests for these helpers already exist in \`${testFile.path}\` and are not`,
      "writable. Your declared test file then only needs a single focused UI smoke test, not repeated store coverage.",
    );
  }
  return lines.join("\n");
}

export async function writeScaffoldFile(appDirectory: string, file: ScaffoldFile): Promise<void> {
  await writeFile(path.join(appDirectory, file.path), file.contents, "utf8");
}
