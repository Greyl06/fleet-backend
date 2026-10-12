import {
  Router,
  type Request,
  type Response,
  type NextFunction,
} from "express";
import {
  and,
  asc,
  count,
  desc,
  eq,
  gte,
  inArray,
  lt,
  sql,
  type SQL,
} from "drizzle-orm";
import { db } from "../db/connection.js";
import {
  activityLogs,
  formDefinitions,
  formSubmissionEvents,
  formSubmissions,
  formVersions,
  users,
} from "../db/schema.js";
import { requirePermission } from "../middleware/auth.js";
import {
  canReadAllSubmissions,
  currentSubmissionResponsibility,
  projectVisibleSubmissionData,
} from "./forms.routes.js";
import { projectReportableFields } from "../domain/form-definition.js";
import {
  manilaDateBoundary,
  reportCsv,
  reportQuerySchema,
} from "../domain/reporting.js";
import { rateLimitFormMutation } from "../middleware/arcjet.js";
import { logger } from "../config/logger.js";

export const reportsRouter = Router();
reportsRouter.use((_req, res, next) => {
  res.setHeader("Cache-Control", "no-store");
  next();
});
const exportLimit = 10000;

function readSubmissions(req: Request, res: Response, next: NextFunction) {
  if (
    req.ability?.can("read", "TSRFRequest") ||
    req.ability?.can("read", "SubmissionReport")
  )
    next();
  else
    res
      .status(403)
      .json({ error: "Submission reporting permission required." });
}

function organizationScope(req: Request) {
  return canReadAllSubmissions(req) || req.user?.role === "auditor";
}

function parseJson(text: string): Record<string, unknown> {
  try {
    const value: unknown = JSON.parse(text);
    return value && typeof value === "object" && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : {};
  } catch {
    return {};
  }
}

function errorResponse(res: Response, error: unknown) {
  logger.error({ error }, "Unable to generate report");
  res.status(500).json({ error: "Unable to generate report. Please retry." });
}

async function queryReport(
  req: Request,
  kind: "submissions" | "activity",
  exporting = false,
) {
  return db.transaction(
    async (transaction) => {
      const filters = reportQuerySchema.parse(exporting ? req.body : req.query);
      const scope =
        kind === "activity" || organizationScope(req)
          ? ("organization" as const)
          : ("own" as const);
      const conditions: SQL[] = [];
      const createdAt =
        kind === "activity"
          ? activityLogs.createdAt
          : formSubmissions.createdAt;
      if (filters.from)
        conditions.push(gte(createdAt, manilaDateBoundary(filters.from)));
      if (filters.to)
        conditions.push(lt(createdAt, manilaDateBoundary(filters.to, true)));
      if (kind === "submissions") {
        conditions.push(eq(formDefinitions.key, filters.formKey));
        if (scope === "own")
          conditions.push(eq(formSubmissions.createdById, req.user!.id));
        if (filters.status)
          conditions.push(eq(formSubmissions.status, filters.status));
        if (filters.stage)
          conditions.push(eq(formSubmissions.stage, filters.stage));
        if (filters.late)
          conditions.push(eq(formSubmissions.isLate, filters.late === "true"));
        if (filters.reference)
          conditions.push(
            eq(formSubmissions.submissionNumber, filters.reference),
          );
      } else {
        if (filters.module)
          conditions.push(eq(activityLogs.module, filters.module));
        if (filters.action)
          conditions.push(eq(activityLogs.action, filters.action));
        if (filters.actorRole)
          conditions.push(eq(activityLogs.userRole, filters.actorRole));
        if (filters.actorId)
          conditions.push(
            sql`${activityLogs.metadataJson}::jsonb ->> 'actorId' = ${filters.actorId}`,
          );
        if (filters.severity)
          conditions.push(eq(activityLogs.severity, filters.severity));
      }
      const where = and(...conditions);
      const limit = exporting ? exportLimit : filters.pageSize;
      const offset = exporting ? 0 : (filters.page - 1) * filters.pageSize;
      const query = transaction
        .select({ total: count() })
        .from(formSubmissions)
        .innerJoin(
          formVersions,
          eq(formSubmissions.formVersionId, formVersions.id),
        )
        .innerJoin(
          formDefinitions,
          eq(formVersions.formDefinitionId, formDefinitions.id),
        )
        .where(where);
      const [totals] =
        kind === "submissions"
          ? await query
          : await transaction
              .select({ total: count() })
              .from(activityLogs)
              .where(where);
      if (exporting && totals.total > exportLimit)
        return { tooLarge: true as const };
      const meta = {
        generatedAt: new Date().toISOString(),
        timezone: "Asia/Manila" as const,
        scope,
        filters,
        total: totals.total,
        page: filters.page,
        pageSize: filters.pageSize,
      };
      if (kind === "activity") {
        const logs = await transaction
          .select()
          .from(activityLogs)
          .where(where)
          .orderBy(desc(activityLogs.createdAt), desc(activityLogs.id))
          .limit(limit)
          .offset(offset);
        const rows = logs.map((row) => {
          const metadata = parseJson(row.metadataJson);
          const identifier = (key: string) =>
            typeof metadata[key] === "string"
              ? (metadata[key] as string)
              : null;
          return {
            id: row.id,
            createdAt: row.createdAt.toISOString(),
            userName: row.userName,
            userRole: row.userRole,
            action: row.action,
            module: row.module,
            severity: row.severity,
            actorId: identifier("actorId"),
            recordId: identifier("recordId"),
            submissionId: identifier("submissionId"),
          };
        });
        return { meta, rows };
      }
      const [summary] = await transaction
        .select({
          pending: sql<number>`count(*) filter (where ${formSubmissions.status} in ('draft', 'in_review', 'approved', 'in_progress'))::int`,
          completed: sql<number>`count(*) filter (where ${formSubmissions.status} = 'completed')::int`,
          returned: sql<number>`count(*) filter (where ${formSubmissions.status} = 'returned')::int`,
          rejected: sql<number>`count(*) filter (where ${formSubmissions.status} = 'rejected')::int`,
          cancelled: sql<number>`count(*) filter (where ${formSubmissions.status} = 'cancelled')::int`,
          late: sql<number>`count(*) filter (where ${formSubmissions.isLate})::int`,
        })
        .from(formSubmissions)
        .innerJoin(
          formVersions,
          eq(formSubmissions.formVersionId, formVersions.id),
        )
        .innerJoin(
          formDefinitions,
          eq(formVersions.formDefinitionId, formDefinitions.id),
        )
        .where(where);
      const selected = await transaction
        .select({
          submission: formSubmissions,
          version: formVersions,
          definition: formDefinitions,
        })
        .from(formSubmissions)
        .innerJoin(
          formVersions,
          eq(formSubmissions.formVersionId, formVersions.id),
        )
        .innerJoin(
          formDefinitions,
          eq(formVersions.formDefinitionId, formDefinitions.id),
        )
        .where(where)
        .orderBy(desc(formSubmissions.createdAt), desc(formSubmissions.id))
        .limit(limit)
        .offset(offset);
      const headIds = selected.flatMap(({ submission }) =>
        submission.departmentHeadUserId
          ? [submission.departmentHeadUserId]
          : [],
      );
      const heads = headIds.length
        ? await transaction
            .select({ id: users.id, name: users.name, role: users.role })
            .from(users)
            .where(and(inArray(users.id, headIds), eq(users.status, "active")))
        : [];
      const rows = selected.map(({ submission, version, definition }) => {
        const schema = parseJson(version.schemaJson);
        const workflow = parseJson(version.workflowJson);
        const visible = projectVisibleSubmissionData(
          schema,
          workflow,
          submission.stage,
          req.user!.role,
          parseJson(submission.dataJson),
          parseJson(submission.labelSnapshotsJson),
          scope === "own",
        );
        const data = projectReportableFields(visible.schema, visible.data);
        const labels: Record<string, string> = {};
        for (const [key, snapshot] of Object.entries(visible.labelSnapshots)) {
          if (
            Object.hasOwn(data, key) &&
            snapshot &&
            typeof snapshot === "object" &&
            "label" in snapshot &&
            typeof snapshot.label === "string"
          )
            labels[key] = snapshot.label;
        }
        return {
          id: submission.id,
          submissionNumber: submission.submissionNumber,
          formKey: definition.key,
          formName: definition.name,
          version: version.version,
          status: submission.status,
          stage: submission.stage,
          isLate: submission.isLate,
          createdAt: submission.createdAt.toISOString(),
          updatedAt: submission.updatedAt.toISOString(),
          data,
          labels,
          ...currentSubmissionResponsibility(
            submission.stage,
            submission.status,
            workflow,
            { name: submission.createdByName, role: submission.createdByRole },
            heads.find((head) => head.id === submission.departmentHeadUserId) ??
              null,
          ),
        };
      });
      return { meta, summary, rows };
    },
    { isolationLevel: "repeatable read", accessMode: "read only" },
  );
}

reportsRouter.get("/forms", readSubmissions, async (req, res) => {
  try {
    const rows = await db
      .selectDistinct({ key: formDefinitions.key, name: formDefinitions.name })
      .from(formDefinitions)
      .innerJoin(
        formVersions,
        eq(formVersions.formDefinitionId, formDefinitions.id),
      )
      .innerJoin(
        formSubmissions,
        eq(formSubmissions.formVersionId, formVersions.id),
      )
      .where(
        organizationScope(req)
          ? undefined
          : eq(formSubmissions.createdById, req.user!.id),
      )
      .orderBy(asc(formDefinitions.name));
    res.json(rows);
  } catch (error) {
    errorResponse(res, error);
  }
});

for (const kind of ["submissions", "activity"] as const) {
  const permission =
    kind === "submissions"
      ? readSubmissions
      : requirePermission("read", "AuditLog");
  reportsRouter.get(`/${kind}`, permission, async (req, res) => {
    const validation = reportQuerySchema.safeParse(req.query);
    if (!validation.success) {
      res
        .status(400)
        .json({
          error: "Invalid report filters",
          details: validation.error.flatten(),
        });
      return;
    }
    try {
      res.json(await queryReport(req, kind));
    } catch (error) {
      errorResponse(res, error);
    }
  });
  reportsRouter.post(
    `/${kind}/export`,
    permission,
    rateLimitFormMutation,
    async (req, res) => {
      if (!reportQuerySchema.safeParse(req.body).success) {
        res.status(400).json({ error: "Invalid report filters" });
        return;
      }
      try {
        const report = await queryReport(req, kind, true);
        if ("tooLarge" in report) {
          res
            .status(422)
            .json({
              error:
                "Export exceeds 10,000 records. Narrow the date range or filters.",
            });
          return;
        }
        const rows: Record<string, unknown>[] = report.rows.map((row) => {
          const context = {
            generatedAt: report.meta.generatedAt,
            timezone: report.meta.timezone,
            scope: report.meta.scope,
            filters: JSON.stringify(report.meta.filters),
            total: report.meta.total,
          };
          if ("submissionNumber" in row) {
            const {
              data,
              labels,
              currentAssignee,
              currentResponsibleRoles,
              ...fields
            } = row;
            return {
              ...context,
              ...fields,
              currentAssignee: currentAssignee?.name ?? "",
              currentResponsibleRoles: currentResponsibleRoles.join("; "),
              reportableFields: data,
              savedLabels: labels,
            };
          }
          return { ...context, ...row };
        });
        const columns =
          kind === "submissions"
            ? [
                "generatedAt",
                "timezone",
                "scope",
                "filters",
                "total",
                "id",
                "submissionNumber",
                "formKey",
                "formName",
                "version",
                "status",
                "stage",
                "isLate",
                "createdAt",
                "updatedAt",
                "currentAssignee",
                "currentResponsibleRoles",
                "reportableFields",
                "savedLabels",
              ]
            : [
                "generatedAt",
                "timezone",
                "scope",
                "filters",
                "total",
                "id",
                "createdAt",
                "userName",
                "userRole",
                "action",
                "module",
                "severity",
                "actorId",
                "recordId",
                "submissionId",
              ];
        const csv = reportCsv(rows, columns);
        await db
          .insert(activityLogs)
          .values({
            userName: req.user!.name,
            userRole: req.user!.role,
            action: "Exported",
            module: "Reports",
            description: `Exported ${kind} report (${rows.length} records).`,
            severity: "info",
            metadataJson: JSON.stringify({
              actorId: req.user!.id,
              recordType: kind,
              filters: report.meta.filters,
              scope: report.meta.scope,
              rowCount: rows.length,
              generatedAt: report.meta.generatedAt,
            }),
          });
        res.setHeader("Content-Type", "text/csv; charset=utf-8");
        res.setHeader("Cache-Control", "no-store");
        res.setHeader(
          "Content-Disposition",
          `attachment; filename="${kind}-${report.meta.generatedAt.slice(0, 10)}.csv"`,
        );
        res.send(csv);
      } catch (error) {
        errorResponse(res, error);
      }
    },
  );
}

reportsRouter.get(
  "/submissions/:id/events",
  readSubmissions,
  async (req, res) => {
    if (
      !/^[\da-f]{8}-[\da-f]{4}-[\da-f]{4}-[\da-f]{4}-[\da-f]{12}$/i.test(
        String(req.params.id),
      )
    ) {
      res.status(400).json({ error: "Invalid submission ID" });
      return;
    }
    try {
      const [submission] = await db
        .select({ id: formSubmissions.id })
        .from(formSubmissions)
        .where(
          and(
            eq(formSubmissions.id, String(req.params.id)),
            organizationScope(req)
              ? undefined
              : eq(formSubmissions.createdById, req.user!.id),
          ),
        );
      if (!submission) {
        res.status(404).json({ error: "Submission not found" });
        return;
      }
      const events = await db
        .select({
          id: formSubmissionEvents.id,
          submissionId: formSubmissionEvents.submissionId,
          fromStage: formSubmissionEvents.fromStage,
          toStage: formSubmissionEvents.toStage,
          action: formSubmissionEvents.action,
          actorName: formSubmissionEvents.actorName,
          actorRole: formSubmissionEvents.actorRole,
          createdAt: formSubmissionEvents.createdAt,
        })
        .from(formSubmissionEvents)
        .where(eq(formSubmissionEvents.submissionId, submission.id))
        .orderBy(
          asc(formSubmissionEvents.createdAt),
          asc(formSubmissionEvents.id),
        );
      res.json(events);
    } catch (error) {
      errorResponse(res, error);
    }
  },
);
