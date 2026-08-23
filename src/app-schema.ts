import { readFile } from "node:fs/promises";

export const AGENT_ROLES = ["domain", "experience", "quality"] as const;
export type AgentRole = (typeof AGENT_ROLES)[number];

export interface AppSchema {
  version: 1;
  product: {
    name: string;
    promise: string;
    audience: string;
    visual_direction: string;
  };
  journeys: Array<{
    id: string;
    label: string;
    acceptance: string;
  }>;
  data_model: {
    entities: Array<{
      name: string;
      fields: Array<{
        name: string;
        type: "text" | "number" | "date" | "boolean" | "enum";
        required: boolean;
        options?: string[];
      }>;
    }>;
    persistence: string;
    invariants: string[];
  };
  architecture: {
    approach: string;
    starter_changes: string[];
    files: Array<{
      path: string;
      responsibility: string;
      owner: AgentRole;
    }>;
  };
  tasks: Array<{
    agent: AgentRole;
    goal: string;
    files: string[];
  }>;
  quality: {
    edge_cases: string[];
    test_journeys: string[];
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function stringArray(value: unknown, path: string, errors: string[]): value is string[] {
  if (!Array.isArray(value) || !value.every(isNonEmptyString)) {
    errors.push(`${path} must be an array of non-empty strings`);
    return false;
  }
  return true;
}

function safeRelativeAppPath(value: string): boolean {
  return (
    value !== "" &&
    !value.startsWith("/") &&
    !value.split(/[\\/]/u).includes("..") &&
    !value.split(/[\\/]/u).includes("node_modules") &&
    value !== "result.json"
  );
}

export function validateAppSchema(value: unknown): string[] {
  const errors: string[] = [];
  if (!isRecord(value)) return ["schema must be an object"];
  if (value.version !== 1) errors.push("version must be 1");

  const product = value.product;
  if (!isRecord(product)) {
    errors.push("product must be an object");
  } else {
    for (const key of ["name", "promise", "audience", "visual_direction"] as const) {
      if (!isNonEmptyString(product[key])) errors.push(`product.${key} must be a non-empty string`);
    }
  }

  if (!Array.isArray(value.journeys) || value.journeys.length === 0) {
    errors.push("journeys must contain at least one journey");
  } else {
    const ids = new Set<string>();
    value.journeys.forEach((journey, index) => {
      if (!isRecord(journey)) {
        errors.push(`journeys[${index}] must be an object`);
        return;
      }
      for (const key of ["id", "label", "acceptance"] as const) {
        if (!isNonEmptyString(journey[key])) errors.push(`journeys[${index}].${key} must be non-empty`);
      }
      if (isNonEmptyString(journey.id)) {
        if (ids.has(journey.id)) errors.push(`journey id ${journey.id} is duplicated`);
        ids.add(journey.id);
      }
    });
  }

  const dataModel = value.data_model;
  if (!isRecord(dataModel)) {
    errors.push("data_model must be an object");
  } else {
    if (!Array.isArray(dataModel.entities) || dataModel.entities.length === 0) {
      errors.push("data_model.entities must contain at least one entity");
    } else {
      dataModel.entities.forEach((entity, entityIndex) => {
        if (!isRecord(entity) || !isNonEmptyString(entity.name)) {
          errors.push(`data_model.entities[${entityIndex}] must have a name`);
          return;
        }
        if (!Array.isArray(entity.fields) || entity.fields.length === 0) {
          errors.push(`data_model.entities[${entityIndex}].fields must not be empty`);
          return;
        }
        entity.fields.forEach((field, fieldIndex) => {
          const prefix = `data_model.entities[${entityIndex}].fields[${fieldIndex}]`;
          if (!isRecord(field)) {
            errors.push(`${prefix} must be an object`);
            return;
          }
          if (!isNonEmptyString(field.name)) errors.push(`${prefix}.name must be non-empty`);
          if (!["text", "number", "date", "boolean", "enum"].includes(String(field.type))) {
            errors.push(`${prefix}.type is unsupported`);
          }
          if (typeof field.required !== "boolean") errors.push(`${prefix}.required must be boolean`);
          if (field.type === "enum" && !stringArray(field.options, `${prefix}.options`, errors)) return;
        });
      });
    }
    if (!isNonEmptyString(dataModel.persistence)) errors.push("data_model.persistence must be non-empty");
    stringArray(dataModel.invariants, "data_model.invariants", errors);
  }

  const architecture = value.architecture;
  const declaredOwners = new Map<string, AgentRole>();
  if (!isRecord(architecture)) {
    errors.push("architecture must be an object");
  } else {
    if (!isNonEmptyString(architecture.approach)) errors.push("architecture.approach must be non-empty");
    stringArray(architecture.starter_changes, "architecture.starter_changes", errors);
    if (!Array.isArray(architecture.files) || architecture.files.length === 0 || architecture.files.length > 8) {
      errors.push("architecture.files must contain between 1 and 8 files");
    } else {
      architecture.files.forEach((file, index) => {
        const prefix = `architecture.files[${index}]`;
        if (!isRecord(file)) {
          errors.push(`${prefix} must be an object`);
          return;
        }
        if (!isNonEmptyString(file.path) || !safeRelativeAppPath(file.path)) {
          errors.push(`${prefix}.path must be a safe app-relative path`);
        }
        if (!isNonEmptyString(file.responsibility)) errors.push(`${prefix}.responsibility must be non-empty`);
        if (!AGENT_ROLES.includes(file.owner as AgentRole)) errors.push(`${prefix}.owner is unsupported`);
        if (isNonEmptyString(file.path) && AGENT_ROLES.includes(file.owner as AgentRole)) {
          if (declaredOwners.has(file.path)) errors.push(`architecture file ${file.path} is duplicated`);
          declaredOwners.set(file.path, file.owner as AgentRole);
        }
      });
    }
  }

  if (!Array.isArray(value.tasks) || value.tasks.length !== AGENT_ROLES.length) {
    errors.push(`tasks must contain exactly ${AGENT_ROLES.length} tasks`);
  } else {
    const assignedRoles = new Set<AgentRole>();
    value.tasks.forEach((task, index) => {
      const prefix = `tasks[${index}]`;
      if (!isRecord(task)) {
        errors.push(`${prefix} must be an object`);
        return;
      }
      if (!AGENT_ROLES.includes(task.agent as AgentRole)) {
        errors.push(`${prefix}.agent is unsupported`);
      } else {
        const role = task.agent as AgentRole;
        if (assignedRoles.has(role)) errors.push(`task role ${role} is duplicated`);
        assignedRoles.add(role);
      }
      if (!isNonEmptyString(task.goal)) errors.push(`${prefix}.goal must be non-empty`);
      if (stringArray(task.files, `${prefix}.files`, errors)) {
        for (const file of task.files) {
          if (!safeRelativeAppPath(file)) errors.push(`${prefix}.files contains an unsafe path: ${file}`);
          const owner = declaredOwners.get(file);
          if (owner === undefined) {
            errors.push(`${prefix} assigns ${file}, but architecture.files does not declare it`);
          } else if (owner !== task.agent) {
            errors.push(`${prefix} assigns ${file} to ${String(task.agent)}, but architecture assigns ${owner}`);
          }
        }
      }
    });
    for (const role of AGENT_ROLES) {
      if (!assignedRoles.has(role)) errors.push(`tasks must include the ${role} role`);
    }
  }

  const quality = value.quality;
  if (!isRecord(quality)) {
    errors.push("quality must be an object");
  } else {
    stringArray(quality.edge_cases, "quality.edge_cases", errors);
    if (stringArray(quality.test_journeys, "quality.test_journeys", errors) && quality.test_journeys.length === 0) {
      errors.push("quality.test_journeys must not be empty");
    }
  }

  return errors;
}

export async function readAppSchema(filePath: string): Promise<AppSchema> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(await readFile(filePath, "utf8"));
  } catch (error) {
    throw new Error(`Could not read app schema: ${(error as Error).message}`);
  }
  const errors = validateAppSchema(parsed);
  if (errors.length > 0) throw new Error(`Invalid app schema:\n- ${errors.join("\n- ")}`);
  return parsed as unknown as AppSchema;
}
