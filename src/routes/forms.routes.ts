import { Router, Request, Response } from "express";
import {
  and,
  asc,
  desc,
  eq,
  gte,
  inArray,
  isNull,
  lte,
  max,
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
  lovItems,
  lovLists,
  users,
  vehicles,
} from "../db/schema.js";
import { mapInternalRole } from "../auth/abilities.js";
import { requirePermission } from "../middleware/auth.js";
import {
  protectTsrfIntake,
  rateLimitFormMutation,
} from "../middleware/arcjet.js";
import {
  evaluateFormCutoff,
  validateFormSchema,
  validateFormWorkflow,
  validateFormSubmission,
  projectReportableFields,
} from "../domain/form-definition.js";
import { calculateOdometerUpdate } from "../domain/odometer.js";
import { logger } from "../config/logger.js";

export const formsRouter = Router();

const parseJson = (value: string) => {
  try {
    return JSON.parse(value);
  } catch {
    return {};
  }
};

async function recordFormBuilderActivity(
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

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
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

const STATUS_CATEGORIES = new Set([
  "draft",
  "in_review",
  "returned",
  "approved",
  "in_progress",
  "completed",
  "rejected",
  "cancelled",
]);

async function resolveActiveLovLabel(
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

async function resolveDepartmentHeadUserId(
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

async function resolveActiveEntityLabel(
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

function workflowParts(workflow: Record<string, unknown>) {
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

function findHiddenSubmissionFields(
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
      const access = isRecord(fieldPermissions) ? fieldPermissions[role] : undefined;
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

function hasDepartmentLookup(schema: unknown): boolean {
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

function changedFormFieldPaths(
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

function mergeFormChanges(
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

function schemaFieldKeys(schema: unknown, prefix = ""): string[] {
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

formsRouter.get(
  "/",
  requirePermission("read", "FormDefinition"),
  async (_req: Request, res: Response) => {
    try {
      const allDefinitions = await db
        .select()
        .from(formDefinitions)
        .orderBy(asc(formDefinitions.name));

      const allVersions = await db
        .select({
          id: formVersions.id,
          formDefinitionId: formVersions.formDefinitionId,
          version: formVersions.version,
          versionName: formVersions.versionName,
          status: formVersions.status,
          updatedAt: formVersions.updatedAt,
        })
        .from(formVersions)
        .orderBy(desc(formVersions.version));

      const formsWithVersions = allDefinitions.map((def) => {
        const defVersions = allVersions.filter(
          (v) => v.formDefinitionId === def.id,
        );
        const publishedVersion = defVersions.find(
          (v) => v.status === "published",
        );
        const latestDraft = defVersions.find((v) => v.status === "draft");
        const latestVersion = defVersions[0];
        return {
          id: def.id,
          key: def.key,
          name: def.name,
          createdAt: def.createdAt,
          updatedAt: def.updatedAt,
          versionCount: defVersions.length,
          publishedVersion: publishedVersion ? publishedVersion.version : null,
          publishedVersionName: publishedVersion?.versionName ?? null,
          hasDraft: Boolean(latestDraft),
          latestVersion: latestVersion ? latestVersion.version : 1,
        };
      });

      res.json(formsWithVersions);
    } catch (error) {
      res.status(500).json({ error: (error as Error).message });
    }
  },
);

formsRouter.get("/published/:key", async (req: Request, res: Response) => {
  try {
    const [definition] = await db
      .select()
      .from(formDefinitions)
      .where(eq(formDefinitions.key, String(req.params.key)));
    if (!definition)
      return res
        .status(404)
        .json({ error: "Published form definition not found" });
    const versions = await db
      .select()
      .from(formVersions)
      .where(
        and(
          eq(formVersions.formDefinitionId, definition.id),
          eq(formVersions.status, "published"),
        ),
      )
      .orderBy(desc(formVersions.version))
      .limit(1);
    if (versions.length === 0)
      return res
        .status(404)
        .json({ error: "Published form definition not found" });
    res.json({
      ...definition,
      versions: versions.map((version) => {
        const schema = parseJson(version.schemaJson);
        return {
          ...version,
          versionName: version.versionName ?? schema.versionName ?? null,
          schema,
          workflow: parseJson(version.workflowJson),
        };
      }),
    });
  } catch (error) {
    res.status(500).json({ error: (error as Error).message });
  }
});

formsRouter.get(
  "/:key/submissions/report",
  requirePermission("read", "TSRFRequest"),
  async (req: Request, res: Response) => {
    try {
      const [definition] = await db
        .select()
        .from(formDefinitions)
        .where(eq(formDefinitions.key, String(req.params.key)));
      if (!definition)
        return res.status(404).json({ error: "Form definition not found" });
      const requestedLimit = Number(req.query.limit ?? 100);
      const limit = Number.isInteger(requestedLimit)
        ? Math.min(Math.max(requestedLimit, 1), 500)
        : 100;
      const rows = await db
        .select({
          id: formSubmissions.id,
          submissionNumber: formSubmissions.submissionNumber,
          status: formSubmissions.status,
          stage: formSubmissions.stage,
          isLate: formSubmissions.isLate,
          createdAt: formSubmissions.createdAt,
          createdById: formSubmissions.createdById,
          createdByName: formSubmissions.createdByName,
          createdByRole: formSubmissions.createdByRole,
          departmentHeadUserId: formSubmissions.departmentHeadUserId,
          dataJson: formSubmissions.dataJson,
          labelSnapshotsJson: formSubmissions.labelSnapshotsJson,
          schemaJson: formVersions.schemaJson,
          workflowJson: formVersions.workflowJson,
        })
        .from(formSubmissions)
        .innerJoin(
          formVersions,
          eq(formSubmissions.formVersionId, formVersions.id),
        )
        .where(
          canReadAllSubmissions(req)
            ? eq(formVersions.formDefinitionId, definition.id)
            : and(
                eq(formVersions.formDefinitionId, definition.id),
                eq(formSubmissions.createdById, req.user?.id ?? ""),
              ),
        )
        .orderBy(desc(formSubmissions.createdAt))
        .limit(limit);
      const departmentHeadIds = Array.from(
        new Set(
          rows
            .map((row) => row.departmentHeadUserId)
            .filter((id): id is string => id !== null),
        ),
      );
      const departmentHeads = departmentHeadIds.length
        ? await db
            .select({ id: users.id, name: users.name, role: users.role })
            .from(users)
            .where(
              and(
                inArray(users.id, departmentHeadIds),
                eq(users.status, "active"),
              ),
            )
        : [];
      const departmentHeadById = new Map(
        departmentHeads.map((user) => [user.id, user]),
      );
      res.json(
        rows.map((row) => {
          const responsibility = currentSubmissionResponsibility(
            row.stage,
            row.status,
            parseJson(row.workflowJson),
            { name: row.createdByName, role: row.createdByRole },
            row.departmentHeadUserId
              ? (departmentHeadById.get(row.departmentHeadUserId) ?? null)
              : null,
          );
          return {
            id: row.id,
            submissionNumber: row.submissionNumber,
            status: row.status,
            stage: row.stage,
            isLate: row.isLate,
            createdAt: row.createdAt,
            ...responsibility,
            data: projectReportableFields(
              parseJson(row.schemaJson),
              projectVisibleSubmissionData(
                parseJson(row.schemaJson),
                parseJson(row.workflowJson),
                row.stage,
                req.user?.role ?? "",
                parseJson(row.dataJson),
                parseJson(row.labelSnapshotsJson),
                !canReadAllSubmissions(req),
              ).data,
            ),
          };
        }),
      );
    } catch {
      res.status(500).json({ error: "Unable to load form report" });
    }
  },
);

formsRouter.get(
  "/:key",
  requirePermission("read", "FormDefinition"),
  async (req: Request, res: Response) => {
    try {
      const [definition] = await db
        .select()
        .from(formDefinitions)
        .where(eq(formDefinitions.key, String(req.params.key)));
      if (!definition)
        return res.status(404).json({ error: "Form definition not found" });
      const versions = await db
        .select()
        .from(formVersions)
        .where(eq(formVersions.formDefinitionId, definition.id))
        .orderBy(desc(formVersions.version));
      res.json({
        ...definition,
        versions: versions.map((version) => {
          const schema = parseJson(version.schemaJson);
          return {
            ...version,
            versionName: version.versionName ?? schema.versionName ?? null,
            schema,
            workflow: parseJson(version.workflowJson),
          };
        }),
      });
    } catch (error) {
      res.status(500).json({ error: (error as Error).message });
    }
  },
);

formsRouter.post(
  "/:key/submissions",
  protectTsrfIntake,
  rateLimitFormMutation,
  requirePermission("create", "TSRFRequest"),
  async (req: Request, res: Response) => {
    try {
      const [definition] = await db
        .select()
        .from(formDefinitions)
        .where(eq(formDefinitions.key, String(req.params.key)));
      if (!definition)
        return res.status(404).json({ error: "Form definition not found" });
      const [version] = await db
        .select()
        .from(formVersions)
        .where(
          and(
            eq(formVersions.formDefinitionId, definition.id),
            eq(formVersions.status, "published"),
          ),
        )
        .orderBy(desc(formVersions.version))
        .limit(1);
      if (!version)
        return res
          .status(404)
          .json({ error: "Published form version not found" });

      const schema = parseJson(version.schemaJson);
      const data = req.body?.data;
      const validation = await validateFormSubmission(
        schema,
        data,
        resolveActiveLovLabel,
        resolveActiveEntityLabel,
      );
      if (validation.errors.length) {
        return res.status(422).json({
          error: "Submission validation failed",
          details: validation.errors,
        });
      }

      let departmentHeadUserId: string | null = null;
      if (hasDepartmentLookup(schema)) {
        const departmentCode =
          isRecord(data) && typeof data.department === "string"
            ? data.department
            : "";
        departmentHeadUserId = departmentCode
          ? await resolveDepartmentHeadUserId(departmentCode)
          : null;
        if (!departmentHeadUserId) {
          return res.status(422).json({
            error:
              "The selected department does not have an active approver assigned. Contact the Fleet administrator.",
          });
        }
      }

      const workflow = parseJson(version.workflowJson);
      const { stages } = workflowParts(workflow);
      const cutoffPolicy = isRecord(workflow.cutoff)
        ? (workflow.cutoff as {
            time: string;
            timezone: string;
            latePolicy: "flag" | "flag_and_exception_approval";
            exceptionStage?: string;
          })
        : {
            time: "16:00",
            timezone: "Asia/Manila",
            latePolicy: "flag" as const,
          };
      const cutoff = evaluateFormCutoff(new Date(), cutoffPolicy);
      const normalInitialStage =
        typeof workflow.initialStage === "string"
          ? workflow.initialStage
          : "submitted";
      const initialStage =
        cutoff.isLate &&
        cutoffPolicy.latePolicy === "flag_and_exception_approval" &&
        cutoffPolicy.exceptionStage
          ? cutoffPolicy.exceptionStage
          : normalInitialStage;
      const hiddenFields = findHiddenSubmissionFields(
        schema,
        workflow,
        initialStage,
        req.user?.role ?? "",
        data,
      );
      if (hiddenFields.length > 0)
        return res.status(422).json({
          error:
            "Submission contains fields hidden for this role at the initial stage.",
          details: hiddenFields.map(
            (field) => `Hidden field "${field}" cannot be submitted.`,
          ),
        });
      const initialStageConfig = stages.find(
        (stage) => stage.id === initialStage,
      );
      const initialStatus =
        typeof initialStageConfig?.statusCategory === "string" &&
        STATUS_CATEGORIES.has(initialStageConfig.statusCategory)
          ? initialStageConfig.statusCategory
          : "in_review";
      const sequence = await db.execute(
        sql`SELECT nextval('form_submission_number_seq') AS value`,
      );
      const sequenceValue = Number(sequence.rows[0]?.value);
      const submissionNumber = `TSRF-${new Date().getFullYear()}-${String(sequenceValue).padStart(5, "0")}`;

      const created = await db.transaction(async (transaction) => {
        const [submission] = await transaction
          .insert(formSubmissions)
          .values({
            submissionNumber,
            formVersionId: version.id,
            status: initialStatus as typeof formSubmissions.$inferInsert.status,
            stage: initialStage,
            departmentHeadUserId,
            isLate: cutoff.isLate,
            cutoffReason: cutoff.reason,
            dataJson: JSON.stringify(data),
            labelSnapshotsJson: JSON.stringify(validation.labelSnapshots),
            createdById: req.user?.id ?? "unknown",
            createdByName: req.user?.name ?? "unknown",
            createdByRole: req.user?.role ?? "unknown",
          })
          .returning();
        await transaction.insert(formSubmissionEvents).values({
          submissionId: submission.id,
          fromStage: null,
          toStage: initialStage,
          action: cutoff.isLate ? "submitted_after_cutoff" : "submitted",
          actorId: req.user?.id ?? "unknown",
          actorName: req.user?.name ?? "unknown",
          actorRole: req.user?.role ?? "unknown",
          comment: cutoff.reason,
        });
        return submission;
      });

      const [departmentHead] = departmentHeadUserId
        ? await db
            .select({ name: users.name, role: users.role })
            .from(users)
            .where(
              and(
                eq(users.id, departmentHeadUserId),
                eq(users.status, "active"),
              ),
            )
        : [];
      const responsibility = currentSubmissionResponsibility(
        created.stage,
        created.status,
        workflow,
        { name: created.createdByName, role: created.createdByRole },
        departmentHead
          ? { name: departmentHead.name, role: departmentHead.role }
          : null,
      );

      res.status(201).json({
        ...created,
        ...responsibility,
        data: JSON.parse(created.dataJson),
        labelSnapshots: JSON.parse(created.labelSnapshotsJson),
      });
    } catch (error) {
      res.status(500).json({ error: "Unable to create form submission" });
    }
  },
);

formsRouter.post(
  "/submissions/:id/transition",
  rateLimitFormMutation,
  async (req: Request, res: Response) => {
    try {
      const canReviewSubmission = Boolean(
        req.ability?.can("approve", "TSRFRequest") ||
        req.ability?.can("update", "TSRFRequest") ||
        req.ability?.can("manage", "all"),
      );
      const canResubmitSubmission = req.ability?.can("create", "TSRFRequest");
      if (!canReviewSubmission && !canResubmitSubmission)
        return res.status(403).json({ error: "Forbidden" });

      const { toStage, comment } = req.body;
      if (typeof toStage !== "string")
        return res.status(400).json({ error: "toStage is required" });
      const [submission] = await db
        .select()
        .from(formSubmissions)
        .where(eq(formSubmissions.id, String(req.params.id)));
      if (!submission)
        return res.status(404).json({ error: "Form submission not found" });
      if (!canReviewSubmission && submission.createdById !== req.user?.id)
        return res.status(404).json({ error: "Form submission not found" });
      const [version] = await db
        .select()
        .from(formVersions)
        .where(eq(formVersions.id, submission.formVersionId));
      if (!version)
        return res
          .status(409)
          .json({ error: "Pinned form version is unavailable" });

      const workflow = parseJson(version.workflowJson);
      const { stages, transitions } = workflowParts(workflow);
      const transition = transitions.find(
        (candidate) =>
          candidate.from === submission.stage && candidate.to === toStage,
      );
      if (!transition)
        return res
          .status(409)
          .json({ error: "Workflow transition is not configured" });
      const currentStage = stages.find(
        (stage) => stage.id === submission.stage,
      );
      const targetStage = stages.find((stage) => stage.id === toStage);
      const isOwnerResubmission =
        !canReviewSubmission &&
        submission.createdById === req.user?.id &&
        currentStage?.statusCategory === "returned" &&
        toStage === workflow.initialStage &&
        targetStage?.statusCategory === "in_review";
      const allowedRoles = Array.isArray(transition.roles)
        ? transition.roles
        : typeof transition.role === "string"
          ? [transition.role]
          : [];
      const isOwnerCancellation =
        !canReviewSubmission &&
        submission.createdById === req.user?.id &&
        req.user?.role === "department_requester" &&
        targetStage?.statusCategory === "cancelled" &&
        allowedRoles.includes("department_requester");
      if (!canReviewSubmission && !isOwnerResubmission && !isOwnerCancellation)
        return res.status(403).json({
          error:
            "Requestors may only resubmit their own returned request or cancel their own configured request.",
        });
      if (!req.user || !allowedRoles.includes(req.user.role))
        return res
          .status(403)
          .json({ error: "Role is not allowed to perform this transition" });
      if (
        submission.stage === "submitted" &&
        req.user.role === "approver" &&
        submission.departmentHeadUserId !== req.user.id
      ) {
        return res.status(403).json({
          error: "Only the assigned department head can approve this request.",
        });
      }

      const currentData = parseJson(submission.dataJson);
      if (Array.isArray(transition.requiredFields)) {
        const missing = transition.requiredFields.filter(
          (field) =>
            typeof field !== "string" ||
            !isRecord(currentData) ||
            !Object.prototype.hasOwnProperty.call(currentData, field) ||
            currentData[field] === "" ||
            currentData[field] === null ||
            currentData[field] === undefined,
        );
        if (missing.length > 0)
          return res.status(422).json({
            error: "Required transition fields are missing",
            fields: missing,
          });
      }
      const nextStatus = targetStage?.statusCategory;
      if (
        typeof nextStatus !== "string" ||
        !STATUS_CATEGORIES.has(nextStatus)
      ) {
        return res.status(422).json({
          error: "Target stage has an invalid system status category",
        });
      }
      const reasonRequired =
        transition.reasonRequired === true ||
        ["rejected", "cancelled", "returned"].includes(nextStatus);
      if (reasonRequired && (typeof comment !== "string" || !comment.trim())) {
        return res
          .status(400)
          .json({ error: "A reason is required for this transition" });
      }

      const transitionResult = await db.transaction(async (transaction) => {
        let odometerVehicleId: string | null = null;
        let odometerUpdate: ReturnType<typeof calculateOdometerUpdate> | null =
          null;
        if (nextStatus === "completed" && isRecord(currentData)) {
          const rawVehicleId =
            currentData.assignedVehicleId ?? currentData.vehicleId;
          const vehicleId =
            typeof rawVehicleId === "string" ? rawVehicleId.trim() : "";
          const rawEndingKm = currentData.endingKm;
          const hasEndingKm =
            rawEndingKm !== undefined &&
            rawEndingKm !== null &&
            rawEndingKm !== "";
          if (vehicleId || hasEndingKm) {
            if (!vehicleId || typeof rawEndingKm !== "number") {
              return {
                kind: "validation" as const,
                message:
                  "A fleet vehicle and numeric endingKm are both required to complete an odometer-tracked request.",
              };
            }
            const [vehicle] = await transaction
              .select()
              .from(vehicles)
              .where(eq(vehicles.id, vehicleId))
              .for("update");
            if (!vehicle) {
              return {
                kind: "validation" as const,
                message: "The assigned fleet vehicle is unavailable.",
              };
            }
            try {
              odometerUpdate = calculateOdometerUpdate(vehicle, rawEndingKm);
              odometerVehicleId = vehicle.id;
            } catch (error) {
              return {
                kind: "validation" as const,
                message: (error as Error).message,
              };
            }
          }
        }

        const [next] = await transaction
          .update(formSubmissions)
          .set({
            stage: toStage,
            status: nextStatus as typeof formSubmissions.$inferInsert.status,
            updatedAt: new Date(),
          })
          .where(
            and(
              eq(formSubmissions.id, submission.id),
              eq(formSubmissions.stage, submission.stage),
            ),
          )
          .returning();
        if (!next) return { kind: "conflict" as const };
        if (odometerUpdate && odometerVehicleId) {
          await transaction
            .update(vehicles)
            .set({ ...odometerUpdate, updatedAt: new Date() })
            .where(eq(vehicles.id, odometerVehicleId));
        }
        await transaction.insert(formSubmissionEvents).values({
          submissionId: submission.id,
          fromStage: submission.stage,
          toStage,
          action:
            typeof transition.action === "string" ? transition.action : toStage,
          actorId: req.user!.id,
          actorName: req.user!.name,
          actorRole: req.user!.role,
          comment: typeof comment === "string" ? comment.trim() : null,
        });
        return { kind: "success" as const, submission: next };
      });
      if (transitionResult.kind === "validation")
        return res.status(422).json({ error: transitionResult.message });
      if (transitionResult.kind === "conflict")
        return res
          .status(409)
          .json({ error: "Submission stage changed; reload and retry" });
      const updated = transitionResult.submission;
      res.json({
        id: updated.id,
        submissionNumber: updated.submissionNumber,
        stage: updated.stage,
        status: updated.status,
      });
    } catch (error) {
      res.status(500).json({ error: "Unable to transition form submission" });
    }
  },
);

formsRouter.patch(
  "/submissions/:id/data",
  rateLimitFormMutation,
  async (req: Request, res: Response) => {
    try {
      const ability = req.ability;
      const canEditSubmission =
        ability?.can("manage", "all") ||
        ability?.can("create", "TSRFRequest") ||
        ability?.can("update", "TSRFRequest");
      if (!canEditSubmission)
        return res.status(403).json({ error: "Forbidden" });
      if (!isRecord(req.body?.data))
        return res.status(400).json({ error: "data object is required" });

      const [submission] = await db
        .select()
        .from(formSubmissions)
        .where(eq(formSubmissions.id, String(req.params.id)));
      if (!submission)
        return res.status(404).json({ error: "Form submission not found" });
      if (
        !canReadAllSubmissions(req) &&
        submission.createdById !== req.user?.id
      )
        return res.status(404).json({ error: "Form submission not found" });
      const [version] = await db
        .select()
        .from(formVersions)
        .where(eq(formVersions.id, submission.formVersionId));
      if (!version)
        return res
          .status(409)
          .json({ error: "Pinned form version is unavailable" });

      const workflow = parseJson(version.workflowJson);
      const { stages } = workflowParts(workflow);
      const stage = stages.find(
        (candidate) => candidate.id === submission.stage,
      );
      const isReviewer = canReadAllSubmissions(req);
      if (!isReviewer && stage?.statusCategory !== "returned")
        return res.status(403).json({
          error: "Requestors may edit only their returned submissions.",
        });
      const stagePermissions = isRecord(stage?.fieldPermissions)
        ? stage.fieldPermissions
        : {};
      const previousData = parseJson(submission.dataJson);
      if (!isRecord(previousData))
        return res
          .status(500)
          .json({ error: "Stored submission data is invalid" });
      const schema = parseJson(version.schemaJson);
      const schemaFields =
        isRecord(schema) && Array.isArray(schema.sections)
          ? schema.sections.flatMap((section) =>
              isRecord(section) && Array.isArray(section.fields)
                ? section.fields
                : [],
            )
          : [];
      const changedPaths = changedFormFieldPaths(
        schemaFields,
        previousData,
        req.body.data,
      );
      const nextData = mergeFormChanges(
        schemaFields,
        previousData,
        req.body.data,
      );
      const isAdmin = ability?.can("manage", "all") ?? false;
      if (!isAdmin) {
        const role = req.user?.role ?? "";
        const denied = changedPaths.filter((path) => {
          const fieldPermission = stagePermissions[path];
          return !isRecord(fieldPermission) || fieldPermission[role] !== "edit";
        });
        if (denied.length)
          return res.status(403).json({
            error: "Fields are not editable for this role at the current stage",
            fields: denied,
          });
      }

      const validation = await validateFormSubmission(
        schema,
        nextData,
        resolveActiveLovLabel,
        resolveActiveEntityLabel,
      );
      if (validation.errors.length)
        return res.status(422).json({
          error: "Submission validation failed",
          details: validation.errors,
        });
      const updated = await db.transaction(async (transaction) => {
        const [next] = await transaction
          .update(formSubmissions)
          .set({
            dataJson: JSON.stringify(nextData),
            labelSnapshotsJson: JSON.stringify(validation.labelSnapshots),
            updatedAt: new Date(),
          })
          .where(
            and(
              eq(formSubmissions.id, submission.id),
              eq(formSubmissions.stage, submission.stage),
            ),
          )
          .returning();
        if (!next) return null;
        await transaction.insert(formSubmissionEvents).values({
          submissionId: submission.id,
          fromStage: submission.stage,
          toStage: submission.stage,
          action: "data_updated",
          actorId: req.user?.id ?? "unknown",
          actorName: req.user?.name ?? "unknown",
          actorRole: req.user?.role ?? "unknown",
        });
        return next;
      });
      if (!updated)
        return res
          .status(409)
          .json({ error: "Submission stage changed; reload and retry" });
      res.json({
        id: updated.id,
        submissionNumber: updated.submissionNumber,
        stage: updated.stage,
        status: updated.status,
      });
    } catch {
      res.status(500).json({ error: "Unable to update form submission" });
    }
  },
);

formsRouter.get(
  "/submissions/:id",
  requirePermission("read", "TSRFRequest"),
  async (req: Request, res: Response) => {
    try {
      const [submission] = await db
        .select()
        .from(formSubmissions)
        .where(eq(formSubmissions.id, String(req.params.id)));
      if (!submission)
        return res.status(404).json({ error: "Form submission not found" });
      if (
        !canReadAllSubmissions(req) &&
        submission.createdById !== req.user?.id
      )
        return res.status(404).json({ error: "Form submission not found" });
      const [version] = await db
        .select()
        .from(formVersions)
        .where(eq(formVersions.id, submission.formVersionId));
      if (!version)
        return res
          .status(409)
          .json({ error: "Pinned form version is unavailable" });
      const formSchema = parseJson(version.schemaJson);
      const strictFieldAccess = !canReadAllSubmissions(req);
      const projected = projectVisibleSubmissionData(
        formSchema,
        parseJson(version.workflowJson),
        submission.stage,
        req.user?.role ?? "",
        parseJson(submission.dataJson),
        parseJson(submission.labelSnapshotsJson),
        strictFieldAccess,
      );
      const workflow = parseJson(version.workflowJson);
      const { stages, transitions } = workflowParts(workflow);
      const initialStageId =
        typeof workflow.initialStage === "string"
          ? workflow.initialStage
          : null;
      const initialStage = stages.find((stage) => stage.id === initialStageId);
      const hasOwnerResubmitTransition = transitions.some((transition) => {
        const roles = Array.isArray(transition.roles)
          ? transition.roles
          : typeof transition.role === "string"
            ? [transition.role]
            : [];
        return (
          transition.from === submission.stage &&
          transition.to === initialStageId &&
          roles.includes(req.user?.role ?? "")
        );
      });
      const resubmitStage =
        strictFieldAccess &&
        submission.createdById === req.user?.id &&
        stages.find((stage) => stage.id === submission.stage)
          ?.statusCategory === "returned" &&
        initialStage?.statusCategory === "in_review" &&
        hasOwnerResubmitTransition
          ? initialStageId
          : null;
      const [departmentHead] =
        submission.departmentHeadUserId && submission.stage === "submitted"
          ? await db
              .select({ name: users.name, role: users.role })
              .from(users)
              .where(
                and(
                  eq(users.id, submission.departmentHeadUserId),
                  eq(users.status, "active"),
                ),
              )
          : [];
      const responsibility = currentSubmissionResponsibility(
        submission.stage,
        submission.status,
        parseJson(version.workflowJson),
        { name: submission.createdByName, role: submission.createdByRole },
        departmentHead
          ? {
              name: departmentHead.name,
              role: mapInternalRole(departmentHead.role) ?? departmentHead.role,
            }
          : null,
      );
      const { dataJson, labelSnapshotsJson, ...submissionFields } = submission;
      res.json({
        ...submissionFields,
        ...responsibility,
        formSchema: projected.schema,
        data: projected.data,
        labelSnapshots: projected.labelSnapshots,
        fieldAccess: projected.fieldAccess,
        resubmitStage,
      });
    } catch {
      res.status(500).json({ error: "Unable to load form submission" });
    }
  },
);

formsRouter.get(
  "/submissions/:id/events",
  requirePermission("read", "TSRFRequest"),
  async (req: Request, res: Response) => {
    try {
      const [submission] = await db
        .select({
          id: formSubmissions.id,
          createdById: formSubmissions.createdById,
        })
        .from(formSubmissions)
        .where(eq(formSubmissions.id, String(req.params.id)));
      if (!submission)
        return res.status(404).json({ error: "Form submission not found" });
      if (
        !canReadAllSubmissions(req) &&
        submission.createdById !== req.user?.id
      )
        return res.status(404).json({ error: "Form submission not found" });
      const events = await db
        .select()
        .from(formSubmissionEvents)
        .where(eq(formSubmissionEvents.submissionId, String(req.params.id)))
        .orderBy(formSubmissionEvents.createdAt);
      res.json(events);
    } catch {
      res.status(500).json({ error: "Unable to load form submission events" });
    }
  },
);

formsRouter.post(
  "/",
  requirePermission("manage", "FormDefinition"),
  async (req: Request, res: Response) => {
    try {
      const { key, name, versionName, schema, workflow = {} } = req.body;
      if (!key || !name || !schema)
        return res
          .status(400)
          .json({ error: "key, name, and schema are required" });
      const normalizedKey = String(key).trim().toLowerCase();
      const [existing] = await db
        .select({ id: formDefinitions.id })
        .from(formDefinitions)
        .where(eq(formDefinitions.key, normalizedKey));
      if (existing) {
        return res
          .status(409)
          .json({ error: `A form with key "${normalizedKey}" already exists.` });
      }
      const resolvedVersionName =
        typeof versionName === "string" && versionName.trim()
          ? versionName.trim()
          : typeof schema?.versionName === "string" && schema.versionName.trim()
          ? schema.versionName.trim()
          : null;
      const nextSchema = {
        ...schema,
        key: normalizedKey,
        name,
        ...(resolvedVersionName ? { versionName: resolvedVersionName } : {}),
      };
      const [definition] = await db
        .insert(formDefinitions)
        .values({ key: normalizedKey, name })
        .returning();
      const [version] = await db
        .insert(formVersions)
        .values({
          formDefinitionId: definition.id,
          version: 1,
          versionName: resolvedVersionName,
          schemaJson: JSON.stringify(nextSchema),
          workflowJson: JSON.stringify(workflow),
          status: "draft",
        })
        .returning();
      await recordFormBuilderActivity(req, {
        action: "Created",
        operation: "form_definition_created",
        description: `Created form definition "${name}" (${key}), draft v${version.version}.`,
        formDefinitionId: definition.id,
        formKey: definition.key,
        formName: definition.name,
        formVersion: version.version,
      });
      res
        .status(201)
        .json({ ...definition, version: { ...version, versionName: resolvedVersionName, schema: nextSchema, workflow } });
    } catch (error) {
      res.status(400).json({ error: (error as Error).message });
    }
  },
);

formsRouter.post(
  "/:id/versions",
  requirePermission("manage", "FormDefinition"),
  async (req: Request, res: Response) => {
    try {
      let targetDefinitionId = String(req.params.id);
      const [definition] = await db
        .select()
        .from(formDefinitions)
        .where(eq(formDefinitions.id, targetDefinitionId));

      if (!definition) {
        // If caller passed a version ID instead of a definition ID, resolve to parent definition
        const [matchingVersion] = await db
          .select({ formDefinitionId: formVersions.formDefinitionId })
          .from(formVersions)
          .where(eq(formVersions.id, targetDefinitionId));
        if (matchingVersion) {
          targetDefinitionId = matchingVersion.formDefinitionId;
        } else {
          return res.status(404).json({ error: "Form definition not found" });
        }
      }

      const [targetDefinition] = await db
        .select()
        .from(formDefinitions)
        .where(eq(formDefinitions.id, targetDefinitionId));
      if (!targetDefinition)
        return res.status(404).json({ error: "Form definition not found" });

      const [latest] = await db
        .select({ version: max(formVersions.version) })
        .from(formVersions)
        .where(eq(formVersions.formDefinitionId, targetDefinitionId));
      const { schema, workflow = {}, name, versionName } = req.body;
      if (!schema) return res.status(400).json({ error: "schema is required" });
      const nextVersion = Number(latest.version ?? 0) + 1;
      const resolvedVersionName =
        typeof versionName === "string" && versionName.trim()
          ? versionName.trim()
          : typeof schema?.versionName === "string" && schema.versionName.trim()
          ? schema.versionName.trim()
          : null;
      const resolvedFormName =
        typeof name === "string" && name.trim()
          ? name.trim()
          : typeof schema?.name === "string" && schema.name.trim()
          ? schema.name.trim()
          : targetDefinition.name;
      const nextSchema = {
        ...schema,
        name: resolvedFormName,
        ...(resolvedVersionName ? { versionName: resolvedVersionName } : {}),
      };
      if (resolvedFormName !== targetDefinition.name) {
        await db
          .update(formDefinitions)
          .set({ name: resolvedFormName, updatedAt: new Date() })
          .where(eq(formDefinitions.id, targetDefinition.id));
      }
      const [version] = await db
        .insert(formVersions)
        .values({
          formDefinitionId: targetDefinitionId,
          version: nextVersion,
          versionName: resolvedVersionName,
          schemaJson: JSON.stringify(nextSchema),
          workflowJson: JSON.stringify(workflow),
          status: "draft",
        })
        .returning();
      await recordFormBuilderActivity(req, {
        action: "Created",
        operation: "form_draft_created",
        description: `Created draft v${version.version} of form "${resolvedFormName}" (${targetDefinition.key}).`,
        formDefinitionId: targetDefinition.id,
        formKey: targetDefinition.key,
        formName: resolvedFormName,
        formVersion: version.version,
      });
      res.status(201).json({ ...version, versionName: resolvedVersionName, schema: nextSchema, workflow });
    } catch (error) {
      const message =
        (error as any)?.cause?.message || (error as Error).message;
      res.status(400).json({ error: message });
    }
  },
);

formsRouter.put(
  "/versions/:id",
  requirePermission("manage", "FormDefinition"),
  async (req: Request, res: Response) => {
    try {
      const { schema, workflow, name, versionName } = req.body;
      const [draft] = await db
        .select()
        .from(formVersions)
        .where(
          and(
            eq(formVersions.id, String(req.params.id)),
            eq(formVersions.status, "draft"),
          ),
        );
      if (!draft)
        return res.status(404).json({ error: "Draft form version not found" });
      const [definition] = await db
        .select()
        .from(formDefinitions)
        .where(eq(formDefinitions.id, draft.formDefinitionId));
      if (!definition)
        return res.status(404).json({ error: "Form definition not found" });

      const resolvedVersionName =
        typeof versionName === "string" && versionName.trim()
          ? versionName.trim()
          : typeof schema?.versionName === "string" && schema.versionName.trim()
          ? schema.versionName.trim()
          : draft.versionName;

      const resolvedFormName =
        typeof name === "string" && name.trim()
          ? name.trim()
          : typeof schema?.name === "string" && schema.name.trim()
          ? schema.name.trim()
          : definition.name;

      const nextSchema = {
        ...schema,
        name: resolvedFormName,
        ...(resolvedVersionName ? { versionName: resolvedVersionName } : {}),
      };

      if (resolvedFormName !== definition.name) {
        await db
          .update(formDefinitions)
          .set({ name: resolvedFormName, updatedAt: new Date() })
          .where(eq(formDefinitions.id, definition.id));
      }

      const nextWorkflow = workflow ?? {};
      const changedAreas = [
        ...(draft.schemaJson === JSON.stringify(nextSchema) ? [] : ["schema"]),
        ...(draft.workflowJson === JSON.stringify(nextWorkflow)
          ? []
          : ["workflow"]),
        ...(draft.versionName === resolvedVersionName ? [] : ["version_name"]),
      ];
      const [version] = await db
        .update(formVersions)
        .set({
          versionName: resolvedVersionName,
          schemaJson: JSON.stringify(nextSchema),
          workflowJson: JSON.stringify(nextWorkflow),
          updatedAt: new Date(),
        })
        .where(
          and(
            eq(formVersions.id, String(req.params.id)),
            eq(formVersions.status, "draft"),
          ),
        )
        .returning();
      if (!version)
        return res.status(404).json({ error: "Draft form version not found" });
      if (changedAreas.length > 0) {
        await recordFormBuilderActivity(req, {
          action: "Updated",
          operation: "form_draft_updated",
          description: `Updated ${changedAreas.join(" and ")} on draft v${version.version} of form "${resolvedFormName}" (${definition.key}).`,
          formDefinitionId: definition.id,
          formKey: definition.key,
          formName: resolvedFormName,
          formVersion: version.version,
          changedAreas: changedAreas.join(","),
        });
      }
      res.json({ ...version, versionName: resolvedVersionName, schema: nextSchema, workflow: nextWorkflow });
    } catch (error) {
      res.status(400).json({ error: (error as Error).message });
    }
  },
);

formsRouter.delete(
  "/versions/:id",
  requirePermission("manage", "FormDefinition"),
  async (req: Request, res: Response) => {
    try {
      const versionId = String(req.params.id);
      const [targetVersion] = await db
        .select()
        .from(formVersions)
        .where(eq(formVersions.id, versionId));

      if (!targetVersion) {
        return res.status(404).json({ error: "Form version not found" });
      }

      if (targetVersion.status !== "draft") {
        return res.status(400).json({
          error:
            "Only draft form versions can be deleted. Published and archived versions must be preserved for audit history.",
        });
      }

      const [definition] = await db
        .select()
        .from(formDefinitions)
        .where(eq(formDefinitions.id, targetVersion.formDefinitionId));

      await db.delete(formVersions).where(eq(formVersions.id, targetVersion.id));

      if (definition) {
        await recordFormBuilderActivity(req, {
          action: "Deleted",
          operation: "form_draft_deleted",
          description: `Deleted draft v${targetVersion.version} of form "${definition.name}" (${definition.key}).`,
          formDefinitionId: definition.id,
          formKey: definition.key,
          formName: definition.name,
          formVersion: targetVersion.version,
        });
      }

      res.json({
        success: true,
        message: `Draft v${targetVersion.version} deleted successfully.`,
        deletedVersion: targetVersion.version,
        formDefinitionId: targetVersion.formDefinitionId,
      });
    } catch (error) {
      res.status(400).json({ error: (error as Error).message });
    }
  },
);

formsRouter.delete(
  "/:id",
  requirePermission("manage", "FormDefinition"),
  async (req: Request, res: Response) => {
    try {
      const identifier = String(req.params.id).trim();
      const isUuid =
        /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/.test(
          identifier,
        );

      const [definition] = await db
        .select()
        .from(formDefinitions)
        .where(
          isUuid
            ? or(
                eq(formDefinitions.id, identifier),
                eq(formDefinitions.key, identifier.toLowerCase()),
              )
            : eq(formDefinitions.key, identifier.toLowerCase()),
        );

      if (!definition) {
        return res.status(404).json({ error: "Form definition not found" });
      }

      if (definition.key === "tsrf") {
        return res.status(400).json({
          error: "The core TSRF form template is protected and cannot be deleted.",
        });
      }

      // Check if any version of this form definition has submissions
      const versions = await db
        .select({ id: formVersions.id })
        .from(formVersions)
        .where(eq(formVersions.formDefinitionId, definition.id));

      const versionIds = versions.map((v) => v.id);
      if (versionIds.length > 0) {
        const [submissionCount] = await db
          .select({ count: sql<number>`count(*)` })
          .from(formSubmissions)
          .where(inArray(formSubmissions.formVersionId, versionIds));

        const count = Number(submissionCount?.count || 0);
        if (count > 0) {
          return res.status(400).json({
            error: `Cannot delete form "${definition.name}" because it has ${count} existing submission(s). To preserve audit history, forms with submissions cannot be deleted.`,
          });
        }
      }

      // Cascade delete definition (database foreign key cascades to form_versions)
      await db
        .delete(formDefinitions)
        .where(eq(formDefinitions.id, definition.id));

      await recordFormBuilderActivity(req, {
        action: "Deleted",
        operation: "form_definition_deleted",
        description: `Deleted form definition "${definition.name}" (${definition.key}) and its ${versions.length} version(s).`,
        formDefinitionId: definition.id,
        formKey: definition.key,
        formName: definition.name,
        formVersion: 0,
      });

      res.json({
        success: true,
        message: `Form "${definition.name}" deleted successfully.`,
        deletedKey: definition.key,
        deletedId: definition.id,
      });
    } catch (error) {
      res.status(400).json({ error: (error as Error).message });
    }
  },
);

formsRouter.post(
  "/versions/:id/publish",
  requirePermission("manage", "FormDefinition"),
  async (req: Request, res: Response) => {
    try {
      const [draft] = await db
        .select()
        .from(formVersions)
        .where(
          and(
            eq(formVersions.id, String(req.params.id)),
            eq(formVersions.status, "draft"),
          ),
        );
      if (!draft)
        return res.status(404).json({ error: "Draft form version not found" });
      const [definition] = await db
        .select()
        .from(formDefinitions)
        .where(eq(formDefinitions.id, draft.formDefinitionId));
      if (!definition)
        return res.status(404).json({ error: "Form definition not found" });
      const availableLists = await db
        .select({ code: lovLists.code })
        .from(lovLists)
        .where(eq(lovLists.status, "active"));
      const schema = parseJson(draft.schemaJson);
      const workflow = parseJson(draft.workflowJson);
      const [publishedVersion] = await db
        .select({ schemaJson: formVersions.schemaJson })
        .from(formVersions)
        .where(
          and(
            eq(formVersions.formDefinitionId, draft.formDefinitionId),
            eq(formVersions.status, "published"),
          ),
        )
        .orderBy(desc(formVersions.version))
        .limit(1);
      const { confirmRetiredKeys = [], acknowledgeFieldRetirement = false } =
        req.body ?? {};
      const confirmedKeysSet = new Set(
        Array.isArray(confirmRetiredKeys) ? confirmRetiredKeys : [],
      );

      let retiredKeysList: string[] = [];
      if (publishedVersion) {
        const previousKeys = new Set(
          schemaFieldKeys(parseJson(publishedVersion.schemaJson)),
        );
        const nextKeys = new Set(schemaFieldKeys(schema));
        const removedKeys = [...previousKeys].filter(
          (key) => !nextKeys.has(key),
        );
        const unconfirmedRemovedKeys = removedKeys.filter(
          (key) => !acknowledgeFieldRetirement && !confirmedKeysSet.has(key),
        );

        if (unconfirmedRemovedKeys.length > 0) {
          return res.status(422).json({
            error: "Published field keys cannot be changed or removed",
            details: unconfirmedRemovedKeys.map(
              (key) => `Published field key "${key}" must be retained.`,
            ),
            canRetire: true,
            removedKeys: unconfirmedRemovedKeys,
          });
        }
        retiredKeysList = removedKeys;
      }
      let activeWorkflow = workflow;
      if (isRecord(workflow) && Array.isArray(workflow.stages)) {
        const nextKeys = new Set(schemaFieldKeys(schema));
        let workflowUpdated = false;
        const cleanedStages = workflow.stages.map((stage) => {
          if (!isRecord(stage) || !isRecord(stage.fieldPermissions)) return stage;
          const cleanedPerms: Record<string, unknown> = {};
          let permsModified = false;
          for (const [fKey, val] of Object.entries(stage.fieldPermissions)) {
            if (nextKeys.has(fKey)) {
              cleanedPerms[fKey] = val;
            } else {
              permsModified = true;
            }
          }
          if (permsModified) {
            workflowUpdated = true;
            return { ...stage, fieldPermissions: cleanedPerms };
          }
          return stage;
        });

        let cleanedTransitions = workflow.transitions;
        if (Array.isArray(workflow.transitions)) {
          cleanedTransitions = workflow.transitions.map((trans) => {
            if (!isRecord(trans) || !Array.isArray(trans.requiredFields)) return trans;
            const validReqs = trans.requiredFields.filter(
              (f) => typeof f === "string" && nextKeys.has(f),
            );
            if (validReqs.length !== trans.requiredFields.length) {
              workflowUpdated = true;
              return { ...trans, requiredFields: validReqs };
            }
            return trans;
          });
        }

        if (workflowUpdated) {
          activeWorkflow = {
            ...workflow,
            stages: cleanedStages,
            transitions: cleanedTransitions,
          };
          await db
            .update(formVersions)
            .set({
              workflowJson: JSON.stringify(activeWorkflow),
              updatedAt: new Date(),
            })
            .where(eq(formVersions.id, draft.id));
        }
      }

      const validationErrors = [
        ...validateFormSchema(
          schema,
          new Set(availableLists.map((list) => list.code)),
        ),
        ...validateFormWorkflow(activeWorkflow, schema),
      ];
      if (validationErrors.length > 0)
        return res.status(422).json({
          error: "Form schema validation failed",
          details: validationErrors,
        });
      const publishedFormName =
        typeof schema.name === "string" && schema.name.trim()
          ? schema.name.trim()
          : definition.name;
      if (publishedFormName !== definition.name) {
        await db
          .update(formDefinitions)
          .set({ name: publishedFormName, updatedAt: new Date() })
          .where(eq(formDefinitions.id, definition.id));
      }
      await db
        .update(formVersions)
        .set({ status: "archived", updatedAt: new Date() })
        .where(
          and(
            eq(formVersions.formDefinitionId, draft.formDefinitionId),
            eq(formVersions.status, "published"),
          ),
        );
      const [published] = await db
        .update(formVersions)
        .set({
          status: "published",
          publishedBy: req.user?.name ?? "system",
          publishedAt: new Date(),
          updatedAt: new Date(),
        })
        .where(eq(formVersions.id, draft.id))
        .returning();
      const retiredSuffix =
        retiredKeysList.length > 0
          ? ` (retired fields: ${retiredKeysList.join(", ")})`
          : "";
      await recordFormBuilderActivity(req, {
        action: "Published",
        operation: "form_version_published",
        description: `Published v${published.version} of form "${publishedFormName}" (${definition.key})${retiredSuffix}.`,
        formDefinitionId: definition.id,
        formKey: definition.key,
        formName: publishedFormName,
        formVersion: published.version,
      });
      res.json({
        ...published,
        versionName: published.versionName ?? schema.versionName ?? null,
        schema: parseJson(published.schemaJson),
        workflow: parseJson(published.workflowJson),
        retiredKeys: retiredKeysList,
      });
    } catch (error) {
      res.status(400).json({ error: (error as Error).message });
    }
  },
);
