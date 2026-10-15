import { Router, Request, Response } from "express";
import { and, desc, eq, inArray, sql } from "drizzle-orm";
import { z } from "zod";
import { db } from "../db/connection.js";
import {
  formDefinitions,
  formSubmissionEvents,
  formSubmissions,
  formVersions,
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
  projectReportableFields,
  validateFormSubmission,
} from "../domain/form-definition.js";
import { calculateOdometerUpdate } from "../domain/odometer.js";
import {
  createSubmissionAccessSchemas,
  effectiveReadWorkflow,
  submissionVisibility,
} from "../domain/submission-access.js";
import {
  STATUS_CATEGORIES,
  canReadAllSubmissions,
  changedFormFieldPaths,
  currentSubmissionResponsibility,
  findHiddenSubmissionFields,
  hasDepartmentLookup,
  isRecord,
  loadReadPolicies,
  mergeFormChanges,
  parseJson,
  projectVisibleSubmissionData,
  resolveActiveEntityLabel,
  resolveActiveLovLabel,
  resolveDepartmentHeadUserId,
  workflowParts,
} from "./forms-common.js";

export const formsSubmissionRouter = Router();
const accessSchemas = createSubmissionAccessSchemas(z);

formsSubmissionRouter.get(
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
          formVersionId: formSubmissions.formVersionId,
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
      const policies = await loadReadPolicies(
        rows.map((row) => row.formVersionId),
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
                effectiveReadWorkflow(
                  parseJson(row.workflowJson),
                  policies.get(row.formVersionId),
                ),
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

formsSubmissionRouter.get(
  "/:key/submissions",
  requirePermission("read", "TSRFRequest"),
  async (req: Request, res: Response) => {
    const input = accessSchemas.registerQuery.safeParse(req.query);
    if (!input.success)
      return res.status(400).json({ error: "Invalid register filters" });
    const [definition] = await db
      .select()
      .from(formDefinitions)
      .where(eq(formDefinitions.key, String(req.params.key)));
    if (!definition)
      return res.status(404).json({ error: "Form definition not found" });
    const filters = input.data;
    if (filters.formVersionId) {
      const [version] = await db
        .select({ id: formVersions.id })
        .from(formVersions)
        .where(
          and(
            eq(formVersions.id, filters.formVersionId),
            eq(formVersions.formDefinitionId, definition.id),
          ),
        );
      if (!version)
        return res.status(404).json({ error: "Form version not found" });
    }
    const base = and(
      eq(formVersions.formDefinitionId, definition.id),
      canReadAllSubmissions(req)
        ? undefined
        : eq(formSubmissions.createdById, req.user!.id),
    );
    const statusMatches: Record<string, string[]> = {
      pending: ["in_review", "draft"],
      returned: ["returned"],
      approved: ["approved"],
      dispatched: ["in_progress", "completed"],
      rejected: ["rejected", "cancelled"],
      cancelled: ["cancelled"],
    };
    const status = statusMatches[filters.status];
    const baseWhere = and(
      base,
      filters.formVersionId
        ? eq(formSubmissions.formVersionId, filters.formVersionId)
        : undefined,
      filters.sla === "late"
        ? eq(formSubmissions.isLate, true)
        : filters.sla === "on_time"
          ? eq(formSubmissions.isLate, false)
          : undefined,
      filters.search
        ? sql`position(lower(${filters.search}) in lower(${formSubmissions.submissionNumber})) > 0`
        : undefined,
    );
    const where = and(
      baseWhere,
      status
        ? inArray(
            formSubmissions.status,
            status as Array<typeof formSubmissions.$inferSelect.status>,
          )
        : undefined,
      filters.status === "late" ? eq(formSubmissions.isLate, true) : undefined,
    );
    const result = await db.transaction(
      async (transaction) => {
        const versions = await transaction
          .selectDistinct({
            id: formVersions.id,
            version: formVersions.version,
            versionName: formVersions.versionName,
            status: formVersions.status,
          })
          .from(formVersions)
          .innerJoin(
            formSubmissions,
            eq(formSubmissions.formVersionId, formVersions.id),
          )
          .where(base)
          .orderBy(desc(formVersions.version));
        const [counts] = await transaction
          .select({
            all: sql<number>`count(*)::int`,
            pending: sql<number>`count(*) filter (where ${formSubmissions.status} in ('draft', 'in_review'))::int`,
            returned: sql<number>`count(*) filter (where ${formSubmissions.status} = 'returned')::int`,
            approved: sql<number>`count(*) filter (where ${formSubmissions.status} = 'approved')::int`,
            dispatched: sql<number>`count(*) filter (where ${formSubmissions.status} in ('in_progress', 'completed'))::int`,
            rejected: sql<number>`count(*) filter (where ${formSubmissions.status} in ('rejected', 'cancelled'))::int`,
            late: sql<number>`count(*) filter (where ${formSubmissions.isLate})::int`,
          })
          .from(formSubmissions)
          .innerJoin(
            formVersions,
            eq(formSubmissions.formVersionId, formVersions.id),
          )
          .where(baseWhere);
        const [filtered] = status || filters.status === "late"
          ? await transaction
              .select({ total: sql<number>`count(*)::int` })
              .from(formSubmissions)
              .innerJoin(
                formVersions,
                eq(formSubmissions.formVersionId, formVersions.id),
              )
              .where(where)
          : [{ total: counts.all }];
        const summary = {
          total: filtered.total,
          all: counts.all,
          pending: counts.pending,
          returned: counts.returned,
          approved: counts.approved,
          dispatched: counts.dispatched,
          rejected: counts.rejected,
          late: counts.late,
        };
        const records = await transaction
          .select({ submission: formSubmissions, version: formVersions })
          .from(formSubmissions)
          .innerJoin(
            formVersions,
            eq(formSubmissions.formVersionId, formVersions.id),
          )
          .where(where)
          .orderBy(desc(formSubmissions.createdAt), desc(formSubmissions.id))
          .limit(filters.pageSize)
          .offset((filters.page - 1) * filters.pageSize);
        const policies = await loadReadPolicies(
          records.map((row) => row.version.id),
          transaction,
        );
        const headIds = records.flatMap((row) =>
          row.submission.departmentHeadUserId
            ? [row.submission.departmentHeadUserId]
            : [],
        );
        const heads = headIds.length
          ? await transaction
              .select({ id: users.id, name: users.name, role: users.role })
              .from(users)
              .where(
                and(inArray(users.id, headIds), eq(users.status, "active")),
              )
          : [];
        const rows = records.map(({ submission, version }) => {
          const schema = parseJson(version.schemaJson);
          const workflow = parseJson(version.workflowJson);
          const policy = policies.get(version.id);
          const data = parseJson(submission.dataJson);
          const projected = projectVisibleSubmissionData(
            schema,
            effectiveReadWorkflow(workflow, policy),
            submission.stage,
            req.user!.role,
            data,
            parseJson(submission.labelSnapshotsJson),
            !canReadAllSubmissions(req),
          );
          return {
            id: submission.id,
            submissionNumber: submission.submissionNumber,
            status: submission.status,
            stage: submission.stage,
            isLate: submission.isLate,
            createdAt: submission.createdAt,
            formDefinitionId: definition.id,
            formKey: definition.key,
            formName: schema.name ?? definition.name,
            formVersionId: version.id,
            version: version.version,
            versionName: version.versionName,
            versionStatus: version.status,
            visibility: submissionVisibility(schema, data, projected.data),
            readPolicyRevision: policy?.revision ?? 0,
            data: projected.data,
            labelSnapshots: projected.labelSnapshots,
            ...currentSubmissionResponsibility(
              submission.stage,
              submission.status,
              workflow,
              {
                name: submission.createdByName,
                role: submission.createdByRole,
              },
              heads.find(
                (head) => head.id === submission.departmentHeadUserId,
              ) ?? null,
            ),
          };
        });
        return {
          rows,
          versions,
          summary,
          meta: {
            total: summary.total,
            page: filters.page,
            pageSize: filters.pageSize,
            formKey: definition.key,
            formName: definition.name,
          },
        };
      },
      { isolationLevel: "repeatable read", accessMode: "read only" },
    );
    res.json(result);
  },
);

formsSubmissionRouter.post(
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

      if (
        req.body?.expectedFormVersionId !== undefined &&
        req.body.expectedFormVersionId !== version.id
      )
        return res
          .status(409)
          .json({
            error:
              "The form changed while you were filling it out. Reload and review before submitting.",
            code: "FORM_VERSION_CHANGED",
          });

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
        await transaction
          .select({ id: formDefinitions.id })
          .from(formDefinitions)
          .where(eq(formDefinitions.id, definition.id))
          .for("update");
        const [current] = await transaction
          .select({ id: formVersions.id })
          .from(formVersions)
          .where(
            and(
              eq(formVersions.formDefinitionId, definition.id),
              eq(formVersions.status, "published"),
            ),
          )
          .orderBy(desc(formVersions.version))
          .limit(1);
        if (current?.id !== version.id) return null;
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

      if (!created)
        return res
          .status(409)
          .json({
            error:
              "The form changed while you were filling it out. Reload and review before submitting.",
            code: "FORM_VERSION_CHANGED",
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

formsSubmissionRouter.post(
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
      let transition = transitions.find(
        (candidate) =>
          candidate.from === submission.stage && candidate.to === toStage,
      );
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
      if (!transition && isOwnerResubmission && toStage === workflow.initialStage) {
        transition = {
          from: submission.stage,
          to: toStage,
          roles: ["department_requester", "admin"],
          action: "resubmitted",
        };
      }
      if (!transition)
        return res
          .status(409)
          .json({ error: "Workflow transition is not configured" });
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

formsSubmissionRouter.patch(
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
      if (validation.errors.length) {
        return res.status(422).json({
          error: "Submission validation failed",
          details: validation.errors,
        });
      }
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

formsSubmissionRouter.get(
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
      const formSchema: Record<string, unknown> = {
        ...parseJson(version.schemaJson),
        version: version.version,
        status: version.status,
        versionName: version.versionName ?? null,
      };
      const strictFieldAccess = !canReadAllSubmissions(req);
      const policy = (await loadReadPolicies([version.id])).get(version.id);
      const projected = projectVisibleSubmissionData(
        formSchema,
        effectiveReadWorkflow(parseJson(version.workflowJson), policy),
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
      const isReturnedStage =
        stages.find((stage) => stage.id === submission.stage)
          ?.statusCategory === "returned";
      const hasOwnerResubmitTransition =
        transitions.some((transition) => {
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
        }) ||
        (isReturnedStage &&
          initialStage?.statusCategory === "in_review" &&
          (req.user?.role === "department_requester" ||
            req.user?.role === "admin" ||
            submission.createdById === req.user?.id));
      const resubmitStage =
        strictFieldAccess &&
        submission.createdById === req.user?.id &&
        isReturnedStage &&
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
      const [definition] = await db
        .select()
        .from(formDefinitions)
        .where(eq(formDefinitions.id, version.formDefinitionId));
      if (req.query.formKey && req.query.formKey !== definition.key)
        return res.status(404).json({ error: "Form submission not found" });
      const availableTransitions = transitions.flatMap((transition) => {
        if (transition.from !== submission.stage) return [];
        const roles = Array.isArray(transition.roles)
          ? transition.roles
          : typeof transition.role === "string"
            ? [transition.role]
            : [];
        if (!req.user || !roles.includes(req.user.role)) return [];
        const target = stages.find((stage) => stage.id === transition.to);
        if (
          !target ||
          typeof target.id !== "string" ||
          typeof target.statusCategory !== "string" ||
          !STATUS_CATEGORIES.has(target.statusCategory)
        )
          return [];
        if (strictFieldAccess) {
          const ownerCancellation =
            submission.createdById === req.user.id &&
            req.user.role === "department_requester" &&
            target.statusCategory === "cancelled";
          if (target.id !== resubmitStage && !ownerCancellation) return [];
        }
        if (
          submission.stage === "submitted" &&
          req.user.role === "approver" &&
          submission.departmentHeadUserId !== req.user.id
        )
          return [];
        return [
          {
            toStage: target.id,
            label: typeof target.label === "string" ? target.label : target.id,
            statusCategory: target.statusCategory,
            reasonRequired:
              transition.reasonRequired === true ||
              ["rejected", "cancelled", "returned"].includes(
                target.statusCategory,
              ),
          },
        ];
      });
      res.json({
        ...submissionFields,
        ...responsibility,
        formDefinitionId: definition.id,
        formKey: definition.key,
        formName: formSchema.name ?? definition.name,
        version: version.version,
        versionName: version.versionName,
        versionStatus: version.status,
        readPolicyRevision: policy?.revision ?? 0,
        visibility: submissionVisibility(
          formSchema,
          parseJson(dataJson),
          projected.data,
        ),
        formSchema: projected.schema,
        data: projected.data,
        labelSnapshots: projected.labelSnapshots,
        fieldAccess: projected.fieldAccess,
        resubmitStage,
        availableTransitions,
      });
    } catch {
      res.status(500).json({ error: "Unable to load form submission" });
    }
  },
);

formsSubmissionRouter.get(
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
