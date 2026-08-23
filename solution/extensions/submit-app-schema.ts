import { writeFileSync } from "node:fs";
import path from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { validateAppSchema } from "../../src/app-schema.js";

const Role = Type.Union([Type.Literal("domain"), Type.Literal("experience"), Type.Literal("quality")]);
const FieldType = Type.Union([
  Type.Literal("text"),
  Type.Literal("number"),
  Type.Literal("date"),
  Type.Literal("boolean"),
  Type.Literal("enum"),
]);

const Params = Type.Object({
  version: Type.Literal(1),
  product: Type.Object({
    name: Type.String(),
    promise: Type.String(),
    audience: Type.String(),
    visual_direction: Type.String(),
  }),
  journeys: Type.Array(
    Type.Object({ id: Type.String(), label: Type.String(), acceptance: Type.String() }),
    { minItems: 1 },
  ),
  data_model: Type.Object({
    entities: Type.Array(
      Type.Object({
        name: Type.String(),
        fields: Type.Array(
          Type.Object({
            name: Type.String(),
            type: FieldType,
            required: Type.Boolean(),
            options: Type.Optional(Type.Array(Type.String())),
          }),
          { minItems: 1 },
        ),
      }),
      { minItems: 1 },
    ),
    persistence: Type.String(),
    invariants: Type.Array(Type.String()),
  }),
  architecture: Type.Object({
    approach: Type.String(),
    starter_changes: Type.Array(Type.String()),
    files: Type.Array(
      Type.Object({ path: Type.String(), responsibility: Type.String(), owner: Role }),
      { minItems: 1, maxItems: 8 },
    ),
  }),
  tasks: Type.Array(
    Type.Object({ agent: Role, goal: Type.String(), files: Type.Array(Type.String(), { minItems: 1 }) }),
    { minItems: 3, maxItems: 3 },
  ),
  quality: Type.Object({
    edge_cases: Type.Array(Type.String()),
    test_journeys: Type.Array(Type.String(), { minItems: 1 }),
  }),
});

export default function submitAppSchema(pi: ExtensionAPI) {
  let submitted = false;
  pi.registerTool({
    name: "submit_app_schema",
    label: "Submit app architecture",
    description: "Validate and save the complete prompt-specific application blueprint as app-schema.json.",
    parameters: Params,
    async execute(_toolCallId, params) {
      if (submitted) {
        return {
          content: [{ type: "text", text: "The schema was already submitted." }],
          details: { errors: ["already submitted"], journeys: 0, files: 0 },
          isError: true,
        };
      }
      const errors = validateAppSchema(params);
      if (errors.length > 0) {
        return {
          content: [{ type: "text", text: `Schema rejected:\n- ${errors.join("\n- ")}` }],
          details: { errors, journeys: 0, files: 0 },
          isError: true,
        };
      }
      writeFileSync(path.join(process.cwd(), "app-schema.json"), `${JSON.stringify(params, null, 2)}\n`, "utf8");
      submitted = true;
      return {
        content: [{ type: "text", text: "Validated app-schema.json written." }],
        details: { errors: [], journeys: params.journeys.length, files: params.architecture.files.length },
      };
    },
  });
}
