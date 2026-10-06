import { Router, Request, Response } from "express";
import { and, desc, eq, inArray, max, sql } from "drizzle-orm";
import { db } from "../db/connection.js";
import {
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

export const formsRouter = Router();

const parseJson = (value: string) => {
  try {
    return JSON.parse(value);
  } catch {
    return {};
  }
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function canReadAllSubmissions(req: Request): boolean {
  const ability = req.ability;
  return Boolean(
    ability?.can("manage", "all") ||
      ability?.can("approve", "TSRFRequest") ||
      ability?.can("update", "TSRFRequest"),
  );
}

function projectVisibleSubmissionData(
  schema: unknown,
  workflow: unknown,
  stageId: string,
  role: string,
  data: unknown,
  labelSnapshots: unknown,
): {
  schema: Record<string, unknown>;
  data: Record<string, unknown>;
  labelSnapshots: Record<string, unknown>;
} {
  if (!isRecord(schema) || !Array.isArray(schema.sections) || !isRecord(data))
    return { schema: {}, data: {}, labelSnapshots: {} };

  const { stages } = workflowParts(isRecord(workflow) ? workflow : {});
  const stage = stages.find((candidate) => candidate.id === stageId);
  const fieldPermissions = isRecord(stage?.fieldPermissions)
    ? stage.fieldPermissions
    : {};
  const hiddenPaths = new Set(
    Object.entries(fieldPermissions)
      .filter(
        ([, permissions]) =>
          isRecord(permissions) && permissions[role] === "hidden",
      )
      .map(([path]) => path),
  );

  const projectFields = (
    fields: unknown[],
    values: Record<string, unknown>,
    prefix = "",
  ): Record<string, unknown> => {
    const projected: Record<string, unknown> = {};
    fields.forEach((field) => {
      if (!isRecord(field) || typeof field.key !== "string") return;
      const path = prefix ? `${prefix}.${field.key}` : field.key;
      if (hiddenPaths.has(path) || !Object.hasOwn(values, field.key)) return;
      const value = values[field.key];
      if (
        field.type === "repeater" &&
        Array.isArray(value) &&
        Array.isArray(field.rowFields)
      ) {
        projected[field.key] = value.map((row) =>
          isRecord(row) ? projectFields(field.rowFields as unknown[], row, path) : row,
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
      if (hiddenPaths.has(path)) return [];
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
    labelSnapshots: Object.fromEntries(
      Object.entries(snapshots).filter(
        ([path]) =>
          !Array.from(hiddenPaths).some(
            (hiddenPath) =>
              path === hiddenPath || path.startsWith(`${hiddenPath}.`),
          ),
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
  const [item] = await db
    .select({ label: lovItems.label })
    .from(lovItems)
    .where(
      and(
        eq(lovItems.listId, list.id),
        eq(lovItems.code, itemCode),
        eq(lovItems.status, "active"),
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
  const [department] = await db
    .select({ approvalUserId: lovItems.approvalUserId })
    .from(lovItems)
    .where(
      and(
        eq(lovItems.listId, departmentList.id),
        eq(lovItems.code, departmentCode),
        eq(lovItems.status, "active"),
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

function currentSubmissionResponsibility(
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

function workflowFieldKeys(fields: unknown[], prefix = ""): string[] {
  return fields.flatMap((field) => {
    if (!isRecord(field) || typeof field.key !== "string") return [];
    const key = prefix ? `${prefix}.${field.key}` : field.key;
    return [
      key,
      ...workflowFieldKeys(
        Array.isArray(field.rowFields) ? field.rowFields : [],
        key,
      ),
    ];
  });
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
      versions: versions.map((version) => ({
        ...version,
        schema: parseJson(version.schemaJson),
        workflow: parseJson(version.workflowJson),
      })),
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
            .where(and(inArray(users.id, departmentHeadIds), eq(users.status, "active")))
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
              parseJson(row.dataJson),
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
        versions: versions.map((version) => ({
          ...version,
          schema: parseJson(version.schemaJson),
          workflow: parseJson(version.workflowJson),
        })),
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
  requirePermission("approve", "TSRFRequest"),
  async (req: Request, res: Response) => {
    try {
      const { toStage, comment } = req.body;
      if (typeof toStage !== "string")
        return res.status(400).json({ error: "toStage is required" });
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
      const { stages, transitions } = workflowParts(workflow);
      const transition = transitions.find(
        (candidate) =>
          candidate.from === submission.stage && candidate.to === toStage,
      );
      if (!transition)
        return res
          .status(409)
          .json({ error: "Workflow transition is not configured" });
      const allowedRoles = Array.isArray(transition.roles)
        ? transition.roles
        : typeof transition.role === "string"
          ? [transition.role]
          : [];
      if (!req.user || !allowedRoles.includes(req.user.role))
        return res
          .status(403)
          .json({ error: "Role is not allowed to perform this transition" });
      if (
        submission.stage === "submitted" &&
        req.user.role === "approver" &&
        submission.departmentHeadUserId !== req.user.id
      ) {
        return res
          .status(403)
          .json({
            error:
              "Only the assigned department head can approve this request.",
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
      const targetStage = stages.find((stage) => stage.id === toStage);
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

      const updated = await db.transaction(async (transaction) => {
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
        if (!next) return null;
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
      const stagePermissions = isRecord(stage?.fieldPermissions)
        ? stage.fieldPermissions
        : {};
      const previousData = parseJson(submission.dataJson);
      if (!isRecord(previousData))
        return res
          .status(500)
          .json({ error: "Stored submission data is invalid" });
      const nextData = { ...previousData, ...req.body.data };
      const changedKeys = Object.keys(req.body.data).filter(
        (key) =>
          JSON.stringify(previousData[key]) !==
          JSON.stringify(req.body.data[key]),
      );
      const isAdmin = ability?.can("manage", "all") ?? false;
      if (!isAdmin) {
        const role = req.user?.role ?? "";
        const editableKeys = new Set(
          workflowFieldKeys(
            isRecord(parseJson(version.schemaJson)) &&
              Array.isArray(parseJson(version.schemaJson).sections)
              ? (parseJson(version.schemaJson).sections as unknown[]).flatMap(
                  (section) =>
                    isRecord(section) && Array.isArray(section.fields)
                      ? section.fields
                      : [],
                )
              : [],
          ),
        );
        const denied = changedKeys.filter((key) => {
          if (!editableKeys.has(key)) return true;
          const fieldPermission = stagePermissions[key];
          return !isRecord(fieldPermission) || fieldPermission[role] !== "edit";
        });
        if (denied.length)
          return res.status(403).json({
            error: "Fields are not editable for this role at the current stage",
            fields: denied,
          });
      }

      const schema = parseJson(version.schemaJson);
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
      const { schema, data, labelSnapshots } = projectVisibleSubmissionData(
        formSchema,
        parseJson(version.workflowJson),
        submission.stage,
        req.user?.role ?? "",
        parseJson(submission.dataJson),
        parseJson(submission.labelSnapshotsJson),
      );
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
        formSchema: schema,
        data,
        labelSnapshots,
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
        .select({ id: formSubmissions.id, createdById: formSubmissions.createdById })
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
      const { key, name, schema, workflow = {} } = req.body;
      if (!key || !name || !schema)
        return res
          .status(400)
          .json({ error: "key, name, and schema are required" });
      const [definition] = await db
        .insert(formDefinitions)
        .values({ key, name })
        .returning();
      const [version] = await db
        .insert(formVersions)
        .values({
          formDefinitionId: definition.id,
          version: 1,
          schemaJson: JSON.stringify(schema),
          workflowJson: JSON.stringify(workflow),
          status: "draft",
        })
        .returning();
      res
        .status(201)
        .json({ ...definition, version: { ...version, schema, workflow } });
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
      const [latest] = await db
        .select({ version: max(formVersions.version) })
        .from(formVersions)
        .where(eq(formVersions.formDefinitionId, String(req.params.id)));
      const { schema, workflow = {} } = req.body;
      if (!schema) return res.status(400).json({ error: "schema is required" });
      const nextVersion = Number(latest.version ?? 0) + 1;
      const [version] = await db
        .insert(formVersions)
        .values({
          formDefinitionId: String(req.params.id),
          version: nextVersion,
          schemaJson: JSON.stringify(schema),
          workflowJson: JSON.stringify(workflow),
          status: "draft",
        })
        .returning();
      res.status(201).json({ ...version, schema, workflow });
    } catch (error) {
      res.status(400).json({ error: (error as Error).message });
    }
  },
);

formsRouter.put(
  "/versions/:id",
  requirePermission("manage", "FormDefinition"),
  async (req: Request, res: Response) => {
    try {
      const { schema, workflow } = req.body;
      const [version] = await db
        .update(formVersions)
        .set({
          schemaJson: JSON.stringify(schema),
          workflowJson: JSON.stringify(workflow ?? {}),
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
      res.json({ ...version, schema, workflow: workflow ?? {} });
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
      if (publishedVersion) {
        const previousKeys = new Set(
          schemaFieldKeys(parseJson(publishedVersion.schemaJson)),
        );
        const nextKeys = new Set(schemaFieldKeys(schema));
        const removedKeys = [...previousKeys].filter(
          (key) => !nextKeys.has(key),
        );
        if (removedKeys.length > 0)
          return res.status(422).json({
            error: "Published field keys cannot be changed or removed",
            details: removedKeys.map(
              (key) => `Published field key "${key}" must be retained.`,
            ),
          });
      }
      const validationErrors = [
        ...validateFormSchema(
          schema,
          new Set(availableLists.map((list) => list.code)),
        ),
        ...validateFormWorkflow(workflow, schema),
      ];
      if (validationErrors.length > 0)
        return res.status(422).json({
          error: "Form schema validation failed",
          details: validationErrors,
        });
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
      res.json({
        ...published,
        schema: parseJson(published.schemaJson),
        workflow: parseJson(published.workflowJson),
      });
    } catch (error) {
      res.status(400).json({ error: (error as Error).message });
    }
  },
);
