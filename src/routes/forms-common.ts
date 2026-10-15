import { Request } from "express";
import {
  and,
  desc,
  eq,
  gte,
  inArray,
  isNull,
  lte,
  or,
  sql,
} from "drizzle-orm";
import { db } from "../db/connection.js";
import {
  activityLogs,
  formDefinitions,
  formSubmissionEvents,
  formSubmissions,
  formVersions,
  formVersionReadAccessRevisions,
  lovItems,
  lovLists,
  users,
  vehicles,
} from "../db/schema.js";
import { mapInternalRole } from "../auth/abilities.js";
import { logger } from "../config/logger.js";
import type { ReadPolicy } from "../domain/submission-access.js";

export const STATUS_CATEGORIES = new Set([
  "draft",
  "in_review",
  "returned",
  "approved",
  "in_progress",
  "completed",
  "rejected",
  "cancelled",
]);

export const parseJson = (value: string): Record<string, unknown> => {
  try {
    return JSON.parse(value);
  } catch {
    return {};
  }
};

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function workflowParts(workflow: Record<string, unknown>) {
  const stages = Array.isArray(workflow.stages)
    ? (workflow.stages.filter(
        (stage) => typeof stage === "object" && stage !== null,
      ) as Array<Record<string, unknown>>)
    : [];
  const transitions = Array.isArray(workflow.transitions)
    ? (workflow.transitions.filter(
        (transition) => typeof transition === "object" && transition !== null,
      ) as Array<Record<string, unknown>>)
    : [];
  return { stages, transitions };
}

export function schemaFieldKeys(schema: unknown, prefix = ""): string[] {
  if (!isRecord(schema) || !Array.isArray(schema.sections)) return [];
  const collect = (fields: unknown[], parent = ""): string[] =>
    fields.flatMap((field) => {
      if (!isRecord(field) || typeof field.key !== "string") return [];
      const key = parent ? `${parent}.${field.key}` : field.key;
      return [
        key,
        ...collect(Array.isArray(field.rowFields) ? field.rowFields : [], key),
      ];
    });
  return schema.sections.flatMap((section) =>
    isRecord(section) && Array.isArray(section.fields)
      ? collect(section.fields, prefix)
      : [],
  );
}

export async function recordFormBuilderActivity(
  req: Request,
  entry: {
    action: string;
    operation: string;
    description: string;
    formDefinitionId: string;
    formKey: string;
    formName: string;
    formVersion: number;
    changedAreas?: string;
  },
): Promise<void> {
  if (!req.user) return;
  try {
    await db.insert(activityLogs).values({
      userName: req.user.name,
      userRole: req.user.role,
      action: entry.action,
      module: "Form Builder",
      description: entry.description,
      severity: "success",
      metadataJson: JSON.stringify({
        actorId: req.user.id,
        area: "form_builder",
        operation: entry.operation,
        formDefinitionId: entry.formDefinitionId,
        formKey: entry.formKey,
        formName: entry.formName,
        formVersion: entry.formVersion,
        ...(entry.changedAreas ? { changedAreas: entry.changedAreas } : {}),
      }),
    });
  } catch (error) {
    logger.error(
      { error, operation: entry.operation },
      "Unable to persist form builder activity",
    );
  }
}

export async function loadReadPolicies(
  versionIds: string[],
  executor: Pick<typeof db, "selectDistinctOn"> = db,
): Promise<Map<string, ReadPolicy>> {
  if (!versionIds.length) return new Map();
  const rows = await executor
    .selectDistinctOn([formVersionReadAccessRevisions.formVersionId])
    .from(formVersionReadAccessRevisions)
    .where(
      inArray(formVersionReadAccessRevisions.formVersionId, [
        ...new Set(versionIds),
      ]),
    )
    .orderBy(
      formVersionReadAccessRevisions.formVersionId,
      desc(formVersionReadAccessRevisions.revision),
    );
  return new Map(
    rows.map((row) => [
      row.formVersionId,
      { revision: row.revision, readGrants: JSON.parse(row.readGrantsJson) },
    ]),
  );
}

export function canReadAllSubmissions(req: Request): boolean {
  const ability = req.ability;
  return Boolean(
    ability?.can("manage", "all") ||
    ability?.can("approve", "TSRFRequest") ||
    ability?.can("update", "TSRFRequest"),
  );
}

export function projectVisibleSubmissionData(
  schema: unknown,
  workflow: unknown,
  stageId: string,
  role: string,
  data: unknown,
  labelSnapshots: unknown,
  strictFieldAccess: boolean,
): {
  schema: Record<string, unknown>;
  data: Record<string, unknown>;
  labelSnapshots: Record<string, unknown>;
  fieldAccess: Record<string, "read" | "edit">;
} {
  if (!isRecord(schema) || !Array.isArray(schema.sections) || !isRecord(data))
    return { schema: {}, data: {}, labelSnapshots: {}, fieldAccess: {} };

  const { stages } = workflowParts(isRecord(workflow) ? workflow : {});
  const stage = stages.find((candidate) => candidate.id === stageId);
  const fieldPermissions = isRecord(stage?.fieldPermissions)
    ? stage.fieldPermissions
    : {};
  const canViewField = (path: string): boolean => {
    const permissions = fieldPermissions[path];
    const access = isRecord(permissions) ? permissions[role] : undefined;
    return strictFieldAccess
      ? access === "read" || access === "edit"
      : access !== "hidden";
  };
  const projectedPaths = new Set<string>();
  const fieldAccess: Record<string, "read" | "edit"> = {};

  const projectFields = (
    fields: unknown[],
    values: Record<string, unknown>,
    prefix = "",
  ): Record<string, unknown> => {
    const projected: Record<string, unknown> = {};
    fields.forEach((field) => {
      if (!isRecord(field) || typeof field.key !== "string") return;
      const path = prefix ? `${prefix}.${field.key}` : field.key;
      if (!canViewField(path) || !Object.hasOwn(values, field.key)) return;
      const value = values[field.key];
      if (
        field.type === "repeater" &&
        Array.isArray(value) &&
        Array.isArray(field.rowFields)
      ) {
        projected[field.key] = value.map((row) =>
          isRecord(row)
            ? projectFields(field.rowFields as unknown[], row, path)
            : row,
        );
      } else {
        projected[field.key] = value;
      }
    });
    return projected;
  };

  const projectSchemaFields = (fields: unknown[], prefix = ""): unknown[] =>
    fields.flatMap((field) => {
      if (!isRecord(field) || typeof field.key !== "string") return [];
      const path = prefix ? `${prefix}.${field.key}` : field.key;
      if (!canViewField(path)) return [];
      projectedPaths.add(path);
      const permissions = fieldPermissions[path];
      fieldAccess[path] =
        isRecord(permissions) && permissions[role] === "edit" ? "edit" : "read";
      return [
        {
          ...field,
          ...(Array.isArray(field.rowFields)
            ? { rowFields: projectSchemaFields(field.rowFields, path) }
            : {}),
        },
      ];
    });

  const fields = schema.sections.flatMap((section) =>
    isRecord(section) && Array.isArray(section.fields) ? section.fields : [],
  );
  const visibleSchema = {
    ...schema,
    sections: schema.sections.map((section) =>
      isRecord(section) && Array.isArray(section.fields)
        ? { ...section, fields: projectSchemaFields(section.fields) }
        : section,
    ),
  };
  const snapshots = isRecord(labelSnapshots) ? labelSnapshots : {};
  return {
    schema: visibleSchema,
    data: projectFields(fields, data),
    fieldAccess,
    labelSnapshots: Object.fromEntries(
      Object.entries(snapshots).filter(([path]) =>
        projectedPaths.has(path.replace(/\[\d+\]/g, "")),
      ),
    ),
  };
}

export async function resolveActiveLovLabel(
  listCode: string,
  itemCode: string,
): Promise<string | null> {
  const [list] = await db
    .select({ id: lovLists.id })
    .from(lovLists)
    .where(and(eq(lovLists.code, listCode), eq(lovLists.status, "active")));
  if (!list) return null;
  const now = new Date();
  const [item] = await db
    .select({ label: lovItems.label })
    .from(lovItems)
    .where(
      and(
        eq(lovItems.listId, list.id),
        eq(lovItems.code, itemCode),
        eq(lovItems.status, "active"),
        or(isNull(lovItems.effectiveFrom), lte(lovItems.effectiveFrom, now)),
        or(isNull(lovItems.effectiveTo), gte(lovItems.effectiveTo, now)),
      ),
    );
  return item?.label ?? null;
}

export async function resolveDepartmentHeadUserId(
  departmentCode: string,
): Promise<string | null> {
  const [departmentList] = await db
    .select({ id: lovLists.id })
    .from(lovLists)
    .where(
      and(eq(lovLists.code, "DEPARTMENTS"), eq(lovLists.status, "active")),
    );
  if (!departmentList) return null;
  const now = new Date();
  const [department] = await db
    .select({ approvalUserId: lovItems.approvalUserId })
    .from(lovItems)
    .where(
      and(
        eq(lovItems.listId, departmentList.id),
        eq(lovItems.code, departmentCode),
        eq(lovItems.status, "active"),
        or(isNull(lovItems.effectiveFrom), lte(lovItems.effectiveFrom, now)),
        or(isNull(lovItems.effectiveTo), gte(lovItems.effectiveTo, now)),
      ),
    );
  if (!department?.approvalUserId) return null;
  const [approver] = await db
    .select()
    .from(users)
    .where(
      and(eq(users.id, department.approvalUserId), eq(users.status, "active")),
    );
  const role = approver ? mapInternalRole(approver.role) : null;
  return approver && (role === "approver" || role === "admin")
    ? approver.id
    : null;
}

export async function resolveActiveEntityLabel(
  entity: string,
  id: string,
): Promise<string | null> {
  if (entity === "drivers") {
    const [driver] = await db
      .select({ name: users.name })
      .from(users)
      .where(
        and(
          eq(users.id, id),
          eq(users.role, "driver"),
          eq(users.status, "active"),
        ),
      );
    return driver?.name ?? null;
  }
  if (entity !== "vehicles") return null;
  const [vehicle] = await db
    .select({ plateNumber: vehicles.plateNumber })
    .from(vehicles)
    .where(and(eq(vehicles.id, id), eq(vehicles.status, "active")));
  return vehicle?.plateNumber ?? null;
}

export function findHiddenSubmissionFields(
  schema: unknown,
  workflow: unknown,
  stageId: string,
  role: string,
  data: unknown,
): string[] {
  if (!isRecord(schema) || !Array.isArray(schema.sections) || !isRecord(data))
    return [];
  const { stages } = workflowParts(isRecord(workflow) ? workflow : {});
  const stage = stages.find((candidate) => candidate.id === stageId);
  const permissions = isRecord(stage?.fieldPermissions)
    ? stage.fieldPermissions
    : {};
  const hidden: string[] = [];
  const hasValue = (value: unknown) =>
    value !== undefined &&
    value !== null &&
    value !== "" &&
    (!Array.isArray(value) || value.length > 0) &&
    (!isRecord(value) || Object.keys(value).length > 0);
  const visit = (
    fields: unknown[],
    values: Record<string, unknown>,
    prefix = "",
  ) => {
    fields.forEach((field) => {
      if (!isRecord(field) || typeof field.key !== "string") return;
      const path = prefix ? `${prefix}.${field.key}` : field.key;
      const fieldPermissions = permissions[path];
      const access = isRecord(fieldPermissions)
        ? fieldPermissions[role]
        : undefined;
      const value = values[field.key];
      if (access === "hidden" && hasValue(value)) {
        hidden.push(path);
        return;
      }
      if (
        field.type === "repeater" &&
        Array.isArray(value) &&
        Array.isArray(field.rowFields)
      ) {
        value.forEach((row) => {
          if (isRecord(row)) visit(field.rowFields as unknown[], row, path);
        });
      }
    });
  };
  visit(
    schema.sections.flatMap((section) =>
      isRecord(section) && Array.isArray(section.fields) ? section.fields : [],
    ),
    data,
  );
  return hidden;
}

export function currentSubmissionResponsibility(
  stageId: string,
  status: string,
  workflow: unknown,
  creator: { name: string; role: string },
  departmentHead: { name: string; role: string } | null,
) {
  let currentAssignee: { name: string; role: string } | null = null;
  const normalizeAssignee = (assignee: { name: string; role: string }) => ({
    ...assignee,
    role: mapInternalRole(assignee.role) ?? assignee.role,
  });
  if (status === "returned") currentAssignee = normalizeAssignee(creator);
  else if (stageId === "submitted" && departmentHead)
    currentAssignee = normalizeAssignee(departmentHead);

  if (["completed", "rejected", "cancelled"].includes(status))
    return { currentAssignee: null, currentResponsibleRoles: [] as string[] };

  const { transitions } = workflowParts(isRecord(workflow) ? workflow : {});
  const currentResponsibleRoles = Array.from(
    new Set(
      transitions.flatMap((transition) => {
        if (transition.from !== stageId) return [];
        const roles = Array.isArray(transition.roles)
          ? transition.roles
          : typeof transition.role === "string"
            ? [transition.role]
            : [];
        return roles.filter((role): role is string => typeof role === "string");
      }),
    ),
  );
  return { currentAssignee, currentResponsibleRoles };
}

export function hasDepartmentLookup(schema: unknown): boolean {
  if (!isRecord(schema) || !Array.isArray(schema.sections)) return false;
  return schema.sections.some(
    (section) =>
      isRecord(section) &&
      Array.isArray(section.fields) &&
      section.fields.some(
        (field) =>
          isRecord(field) &&
          field.key === "department" &&
          isRecord(field.dataSource) &&
          field.dataSource.kind === "lov" &&
          field.dataSource.listCode === "DEPARTMENTS",
      ),
  );
}

export function changedFormFieldPaths(
  fields: unknown[],
  previous: Record<string, unknown>,
  changes: Record<string, unknown>,
  prefix = "",
): string[] {
  return fields.flatMap((candidate) => {
    if (!isRecord(candidate) || typeof candidate.key !== "string") return [];
    const key = candidate.key;
    if (!Object.hasOwn(changes, key)) return [];
    const path = prefix ? `${prefix}.${key}` : key;
    const previousValue = previous[key];
    const nextValue = changes[key];
    if (candidate.type !== "repeater")
      return JSON.stringify(previousValue) === JSON.stringify(nextValue)
        ? []
        : [path];
    if (!Array.isArray(previousValue) || !Array.isArray(nextValue))
      return JSON.stringify(previousValue) === JSON.stringify(nextValue)
        ? []
        : [path];
    if (previousValue.length !== nextValue.length) return [path];
    const rowFields = Array.isArray(candidate.rowFields)
      ? candidate.rowFields
      : [];
    return previousValue.flatMap((previousRow, index) => {
      const nextRow = nextValue[index];
      if (!isRecord(previousRow) || !isRecord(nextRow))
        return JSON.stringify(previousRow) === JSON.stringify(nextRow)
          ? []
          : [path];
      return changedFormFieldPaths(rowFields, previousRow, nextRow, path);
    });
  });
}

export function mergeFormChanges(
  fields: unknown[],
  previous: Record<string, unknown>,
  changes: Record<string, unknown>,
): Record<string, unknown> {
  const merged = { ...previous };
  Object.entries(changes).forEach(([key, value]) => {
    const field = fields.find(
      (candidate) => isRecord(candidate) && candidate.key === key,
    );
    const prevArray = previous[key];
    if (
      !isRecord(field) ||
      field.type !== "repeater" ||
      !Array.isArray(prevArray) ||
      !Array.isArray(value) ||
      prevArray.length !== value.length
    ) {
      merged[key] = value;
      return;
    }
    const rowFields = Array.isArray(field.rowFields) ? field.rowFields : [];
    merged[key] = value.map((row, index) => {
      const previousRow = prevArray[index];
      return isRecord(previousRow) && isRecord(row)
        ? mergeFormChanges(rowFields, previousRow, row)
        : row;
    });
  });
  return merged;
}
