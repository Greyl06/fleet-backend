import type { z as Zod } from "zod";

export type ReadGrants = Record<string, { department_requester: string[] }>;
export type ReadPolicy = { revision: number; readGrants: ReadGrants };
export type Visibility =
  "visible" | "partially_restricted" | "restricted" | "empty";

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function createSubmissionAccessSchemas(z: typeof Zod) {
  const readGrants = z.record(
    z
      .object({ department_requester: z.array(z.string().min(1)).max(1000) })
      .strict(),
  );
  const correction = z
    .object({
      expectedRevision: z.number().int().nonnegative(),
      reason: z.string().trim().min(1).max(2000),
      readGrants,
    })
    .strict();
  const registerQuery = z
    .object({
      formVersionId: z.string().uuid().optional(),
      page: z.coerce.number().int().min(1).default(1),
      pageSize: z.coerce.number().int().min(1).max(100).default(10),
      status: z
        .enum([
          "all",
          "pending",
          "returned",
          "approved",
          "dispatched",
          "rejected",
          "cancelled",
          "late",
        ])
        .default("all"),
      sla: z.enum(["all", "on_time", "late"]).default("all"),
      search: z.string().trim().max(200).default(""),
    })
    .strict();
  const versionStatus = z.enum(["draft", "published", "archived"]);
  const identity = z.object({
    formDefinitionId: z.string().uuid(),
    formKey: z.string(),
    formName: z.string(),
    formVersionId: z.string().uuid(),
    version: z.number().int(),
    versionName: z.string().nullable(),
    versionStatus,
  });
  const row = identity.extend({
    id: z.string().uuid(),
    submissionNumber: z.string(),
    status: z.string(),
    stage: z.string(),
    isLate: z.boolean(),
    createdAt: z.string().datetime(),
    visibility: z.enum([
      "visible",
      "partially_restricted",
      "restricted",
      "empty",
    ]),
    readPolicyRevision: z.number().int().nonnegative(),
    data: z.record(z.unknown()),
    labelSnapshots: z.record(z.unknown()),
    currentAssignee: z
      .object({ name: z.string(), role: z.string() })
      .nullable(),
    currentResponsibleRoles: z.array(z.string()),
  });
  const summary = z.object({
    total: z.number().int(),
    pending: z.number().int(),
    returned: z.number().int(),
    approved: z.number().int(),
    dispatched: z.number().int(),
    late: z.number().int(),
  });
  const registerResponse = z.object({
    rows: z.array(row),
    versions: z.array(
      z.object({
        id: z.string().uuid(),
        version: z.number().int(),
        versionName: z.string().nullable(),
        status: versionStatus,
      }),
    ),
    summary,
    meta: z.object({
      total: z.number().int(),
      page: z.number().int(),
      pageSize: z.number().int(),
      formKey: z.string(),
      formName: z.string(),
    }),
  });
  const policyResponse = z.object({
    formVersionId: z.string().uuid(),
    version: z.number().int(),
    status: versionStatus,
    revision: z.number().int(),
    readGrants,
    affectedSubmissions: z.number().int(),
  });
  const historyResponse = z.array(
    z.object({
      id: z.string().uuid(),
      formVersionId: z.string().uuid(),
      revision: z.number().int(),
      readGrants,
      actorId: z.string(),
      reason: z.string(),
      createdAt: z.string().datetime(),
    }),
  );
  const detailResponse = row.extend({
    createdById: z.string(),
    formSchema: z.record(z.unknown()),
    fieldAccess: z.record(z.enum(["read", "edit"])),
    resubmitStage: z.string().nullable(),
    availableTransitions: z.array(
      z.object({
        toStage: z.string(),
        label: z.string(),
        statusCategory: z.string(),
        reasonRequired: z.boolean(),
      }),
    ),
  });
  const versionConflict = z.object({
    code: z.literal("FORM_VERSION_CHANGED"),
    error: z.string(),
  });
  return {
    correction,
    readGrants,
    registerQuery,
    registerResponse,
    policyResponse,
    historyResponse,
    detailResponse,
    versionConflict,
  };
}

export function schemaPaths(schema: unknown): string[] {
  if (!record(schema) || !Array.isArray(schema.sections)) return [];
  const visit = (fields: unknown[], prefix = ""): string[] =>
    fields.flatMap((field) => {
      if (
        !record(field) ||
        typeof field.key !== "string" ||
        field.type === "notice"
      )
        return [];
      const path = prefix ? `${prefix}.${field.key}` : field.key;
      return [
        path,
        ...(Array.isArray(field.rowFields) ? visit(field.rowFields, path) : []),
      ];
    });
  return schema.sections.flatMap((section) =>
    record(section) && Array.isArray(section.fields)
      ? visit(section.fields)
      : [],
  );
}

export function validateReadGrants(
  schema: unknown,
  workflow: unknown,
  grants: ReadGrants,
): string[] {
  const paths = new Set(schemaPaths(schema));
  const stages =
    record(workflow) && Array.isArray(workflow.stages)
      ? workflow.stages.filter(record)
      : [];
  const errors: string[] = [];
  for (const [stageId, roles] of Object.entries(grants)) {
    const stage = stages.find((candidate) => candidate.id === stageId);
    if (!stage) {
      errors.push(`Unknown stage: ${stageId}`);
      continue;
    }
    const selected = new Set(roles.department_requester);
    for (const path of selected) {
      if (!paths.has(path)) {
        errors.push(`Unknown field: ${path}`);
        continue;
      }
      const parts = path.split(".");
      while (parts.length > 1) {
        parts.pop();
        const parent = parts.join(".");
        const permissions = record(stage.fieldPermissions)
          ? stage.fieldPermissions[parent]
          : undefined;
        const baseline = record(permissions)
          ? permissions.department_requester
          : undefined;
        if (!selected.has(parent) && baseline !== "read" && baseline !== "edit")
          errors.push(`Grant parent field ${parent} before ${path}.`);
      }
    }
  }
  return [...new Set(errors)];
}

export function effectiveReadWorkflow(
  workflow: unknown,
  policy?: ReadPolicy,
): unknown {
  if (!policy || !record(workflow) || !Array.isArray(workflow.stages))
    return workflow;
  return {
    ...workflow,
    stages: workflow.stages.map((stage) => {
      if (!record(stage) || typeof stage.id !== "string") return stage;
      const permissions = {
        ...(record(stage.fieldPermissions) ? stage.fieldPermissions : {}),
      };
      for (const path of policy.readGrants[stage.id]?.department_requester ??
        []) {
        const baseline = record(permissions[path]) ? permissions[path] : {};
        permissions[path] = {
          ...baseline,
          department_requester:
            baseline.department_requester === "edit" ? "edit" : "read",
        };
      }
      return { ...stage, fieldPermissions: permissions };
    }),
  };
}

export function submissionVisibility(
  schema: unknown,
  original: unknown,
  projected: unknown,
): Visibility {
  const pathsWithValues = (data: unknown): Set<string> => {
    const found = new Set<string>();
    if (!record(schema) || !Array.isArray(schema.sections) || !record(data))
      return found;
    const visit = (
      fields: unknown[],
      values: Record<string, unknown>,
      prefix = "",
    ) => {
      for (const field of fields) {
        if (
          !record(field) ||
          typeof field.key !== "string" ||
          field.type === "notice"
        )
          continue;
        const path = prefix ? `${prefix}.${field.key}` : field.key;
        const value = values[field.key];
        if (
          value === undefined ||
          value === null ||
          value === "" ||
          (Array.isArray(value) && value.length === 0)
        )
          continue;
        found.add(path);
        if (Array.isArray(value) && Array.isArray(field.rowFields))
          for (const row of value)
            if (record(row)) visit(field.rowFields, row, path);
      }
    };
    for (const section of schema.sections)
      if (record(section) && Array.isArray(section.fields))
        visit(section.fields, data);
    return found;
  };
  const stored = pathsWithValues(original);
  const visible = pathsWithValues(projected);
  if (stored.size === 0) return "empty";
  if (visible.size === 0) return "restricted";
  return [...stored].every((path) => visible.has(path))
    ? "visible"
    : "partially_restricted";
}

export function restrictedRequesterStages(
  schema: unknown,
  workflow: unknown,
): string[] {
  const paths = schemaPaths(schema);
  if (!paths.length || !record(workflow) || !Array.isArray(workflow.stages))
    return [];
  return workflow.stages
    .filter(record)
    .filter((stage) =>
      paths.some((path) => {
        const permissions = record(stage.fieldPermissions)
          ? stage.fieldPermissions
          : {};
        const parts = path.split(".");
        while (parts.length > 1) {
          parts.pop();
          const parent = permissions[parts.join(".")];
          if (record(parent) && parent.department_requester === "hidden")
            return false;
        }
        const access = permissions[path];
        return (
          !record(access) ||
          !["read", "edit", "hidden"].includes(
            String(access.department_requester),
          )
        );
      }),
    )
    .flatMap((stage) => (typeof stage.id === "string" ? [stage.id] : []));
}
