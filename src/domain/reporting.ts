import { z } from "zod";

export function createReportFilterSchema(zod: typeof import("zod").z) {
  const z = zod;
  const shortText = z.string().max(120).optional();
  const calendarDate = z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/)
    .refine((value) => {
      const date = new Date(`${value}T00:00:00Z`);
      return (
        !Number.isNaN(date.valueOf()) &&
        date.toISOString().slice(0, 10) === value
      );
    }, "Invalid calendar date")
    .optional();

  return z
    .object({
      formKey: z.string().min(1).max(120).default("tsrf"),
      from: calendarDate,
      to: calendarDate,
      status: z
        .enum([
          "draft",
          "in_review",
          "returned",
          "approved",
          "in_progress",
          "completed",
          "rejected",
          "cancelled",
        ])
        .optional(),
      stage: shortText,
      late: z.enum(["true", "false"]).optional(),
      reference: shortText,
      module: shortText,
      action: shortText,
      actorId: shortText,
      actorRole: shortText,
      severity: z.enum(["info", "warning", "critical", "success"]).optional(),
      page: z.coerce.number().int().min(1).max(100000).default(1),
      pageSize: z.coerce.number().int().min(1).max(100).default(25),
    })
    .strict();
}
export const reportQuerySchema = createReportFilterSchema(z).refine(
  (query) => !query.from || !query.to || query.from <= query.to,
  "Start date must not exceed end date",
);

export function createReportSchemas(zod: typeof import("zod").z) {
  const z = zod;
  const reportMetaSchema = z.object({
    generatedAt: z.string(),
    timezone: z.literal("Asia/Manila"),
    scope: z.enum(["own", "organization"]),
    filters: z.record(z.union([z.string(), z.number()])),
    total: z.number(),
    page: z.number(),
    pageSize: z.number(),
  });
  const submissionReportRowSchema = z.object({
    id: z.string(),
    submissionNumber: z.string(),
    formKey: z.string(),
    formName: z.string(),
    version: z.number(),
    status: z.string(),
    stage: z.string(),
    isLate: z.boolean(),
    createdAt: z.string(),
    updatedAt: z.string(),
    currentAssignee: z
      .object({ name: z.string(), role: z.string() })
      .nullable(),
    currentResponsibleRoles: z.array(z.string()),
    data: z.record(z.unknown()),
    labels: z.record(z.string()),
  });
  const submissionReportSchema = z.object({
    meta: reportMetaSchema,
    summary: z.object({
      pending: z.number(),
      completed: z.number(),
      returned: z.number(),
      rejected: z.number(),
      cancelled: z.number(),
      late: z.number(),
    }),
    rows: z.array(submissionReportRowSchema),
  });
  const activityReportRowSchema = z.object({
    id: z.string(),
    createdAt: z.string(),
    userName: z.string(),
    userRole: z.string(),
    action: z.string(),
    module: z.string(),
    severity: z.string(),
    actorId: z.string().nullable(),
    recordId: z.string().nullable(),
    submissionId: z.string().nullable(),
  });
  const activityReportSchema = z.object({
    meta: reportMetaSchema,
    rows: z.array(activityReportRowSchema),
  });
  const reportEventSchema = z.object({
    id: z.string(),
    submissionId: z.string(),
    fromStage: z.string().nullable(),
    toStage: z.string(),
    action: z.string(),
    actorName: z.string(),
    actorRole: z.string(),
    createdAt: z.string(),
  });
  const reportFormsSchema = z.array(
    z.object({ key: z.string(), name: z.string() }),
  );
  return {
    reportMetaSchema,
    submissionReportSchema,
    activityReportSchema,
    reportEventSchema,
    reportFormsSchema,
  };
}

export function manilaDateBoundary(date: string, end = false): Date {
  return new Date(
    new Date(`${date}T00:00:00+08:00`).valueOf() + (end ? 86400000 : 0),
  );
}

export function csvCell(value: unknown): string {
  const text =
    value === null || value === undefined
      ? ""
      : typeof value === "object"
        ? JSON.stringify(value)
        : String(value);
  const safe =
    /^[\s\u0000-\u001f]*[=+@-]/.test(text) || /^[\t\r\n]/.test(text)
      ? `'${text}`
      : text;
  return `"${safe.replace(/"/g, '""')}"`;
}

export function reportCsv(
  rows: Record<string, unknown>[],
  columns: string[],
): string {
  return (
    [
      columns.map(csvCell).join(","),
      ...rows.map((row) =>
        columns.map((column) => csvCell(row[column])).join(","),
      ),
    ].join("\r\n") + "\r\n"
  );
}
