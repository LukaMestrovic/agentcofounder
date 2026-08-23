import type { AgentRole, AppSchema } from "./app-schema.js";
import type { AppVerification, VerificationFailure } from "./types.js";

export interface RepairBrief {
  attempt: 1 | 2;
  product: AppSchema["product"];
  journeys: AppSchema["journeys"];
  invariants: string[];
  failures: VerificationFailure[];
  candidate_files: AppSchema["architecture"]["files"];
}

function filesForOwner(schema: AppSchema, owner: AgentRole): string[] {
  return schema.architecture.files
    .filter((file) => file.owner === owner)
    .map((file) => file.path);
}

function addPaths(target: Set<string>, paths: Iterable<string>, declared: Set<string>): void {
  for (const candidate of paths) {
    if (declared.has(candidate)) target.add(candidate);
  }
}

export function selectRepairFiles(
  schema: AppSchema,
  verification: AppVerification,
  attempt: 1 | 2,
): AppSchema["architecture"]["files"] {
  if (attempt === 2) return [...schema.architecture.files];

  const declared = new Set(schema.architecture.files.map((file) => file.path));
  const selected = new Set<string>();

  for (const failure of verification.failures) {
    const implicated = failure.implicated_files.filter((file) => declared.has(file));
    addPaths(selected, implicated, declared);

    if (failure.check === "test") {
      addPaths(selected, filesForOwner(schema, "quality"), declared);
    }
    if (failure.check === "dev") {
      addPaths(selected, filesForOwner(schema, "experience"), declared);
    }
    if (failure.check === "structure") {
      addPaths(selected, filesForOwner(schema, "experience"), declared);
    }
    if (failure.check === "build" || failure.check === "structure") {
      const owners = new Set<AgentRole>();
      for (const path of implicated) {
        const owner = schema.architecture.files.find((file) => file.path === path)?.owner;
        if (owner) owners.add(owner);
      }
      for (const owner of owners) addPaths(selected, filesForOwner(schema, owner), declared);
      if (implicated.length === 0 && failure.check === "build") {
        addPaths(selected, declared, declared);
      }
    }
  }

  if (selected.size === 0) addPaths(selected, declared, declared);
  return schema.architecture.files.filter((file) => selected.has(file.path));
}

export function buildRepairBrief(
  schema: AppSchema,
  verification: AppVerification,
  attempt: 1 | 2,
): RepairBrief {
  return {
    attempt,
    product: schema.product,
    journeys: schema.journeys,
    invariants: schema.data_model.invariants,
    failures: verification.failures,
    candidate_files: selectRepairFiles(schema, verification, attempt),
  };
}
