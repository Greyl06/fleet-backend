import { Router } from "express";
import { desc, eq, sql } from "drizzle-orm";
import { z } from "zod";
import { db } from "../db/connection.js";
import {
  activityLogs,
  formSubmissions,
  formVersions,
  formVersionReadAccessRevisions,
} from "../db/schema.js";
import { requirePermission } from "../middleware/auth.js";
import { rateLimitFormMutation } from "../middleware/arcjet.js";
import {
  createSubmissionAccessSchemas,
  validateReadGrants,
} from "../domain/submission-access.js";
import { logger } from "../config/logger.js";
import { loadReadPolicies, parseJson } from "./forms-common.js";

export const formsAccessRouter = Router();
const accessSchemas = createSubmissionAccessSchemas(z);

formsAccessRouter.use("/versions/:id/read-access", (req, res, next) => {
  if (!z.string().uuid().safeParse(req.params.id).success)
    return res.status(400).json({ error: "Invalid form version ID" });
  next();
});

formsAccessRouter.get(
  "/versions/:id/read-access",
  requirePermission("manage", "FormDefinition"),
  async (req, res) => {
    const [version] = await db
      .select()
      .from(formVersions)
      .where(eq(formVersions.id, String(req.params.id)));
    if (!version)
      return res.status(404).json({ error: "Form version not found" });
    const policy = (await loadReadPolicies([version.id])).get(version.id);
    const [totals] = await db
      .select({ total: sql<number>`count(*)::int` })
      .from(formSubmissions)
      .where(eq(formSubmissions.formVersionId, version.id));
    res.json({
      formVersionId: version.id,
      version: version.version,
      status: version.status,
      revision: policy?.revision ?? 0,
      readGrants: policy?.readGrants ?? {},
      affectedSubmissions: totals.total,
    });
  },
);

formsAccessRouter.get(
  "/versions/:id/read-access/history",
  requirePermission("manage", "FormDefinition"),
  async (req, res) => {
    const rows = await db
      .select()
      .from(formVersionReadAccessRevisions)
      .where(
        eq(formVersionReadAccessRevisions.formVersionId, String(req.params.id)),
      )
      .orderBy(desc(formVersionReadAccessRevisions.revision));
    res.json(
      rows.map(({ readGrantsJson, ...row }) => ({
        ...row,
        readGrants: parseJson(readGrantsJson),
      })),
    );
  },
);

formsAccessRouter.put(
  "/versions/:id/read-access",
  rateLimitFormMutation,
  requirePermission("manage", "FormDefinition"),
  async (req, res) => {
    const input = accessSchemas.correction.safeParse(req.body);
    if (!input.success)
      return res
        .status(422)
        .json({
          error: "Invalid read correction",
          details: input.error.issues.map((issue) => issue.message),
        });
    try {
      const result = await db.transaction(async (transaction) => {
        const [version] = await transaction
          .select()
          .from(formVersions)
          .where(eq(formVersions.id, String(req.params.id)))
          .for("update");
        if (!version) return { status: 404, error: "Form version not found" };
        if (version.status === "draft")
          return {
            status: 409,
            error: "Edit draft permissions in the workflow editor.",
          };
        const previous = (
          await loadReadPolicies([version.id], transaction)
        ).get(version.id);
        if ((previous?.revision ?? 0) !== input.data.expectedRevision)
          return {
            status: 409,
            error: "Read policy changed; reload before saving.",
          };
        const errors = validateReadGrants(
          parseJson(version.schemaJson),
          parseJson(version.workflowJson),
          input.data.readGrants,
        );
        if (errors.length) return { status: 422, error: errors.join(" ") };
        const [revision] = await transaction
          .insert(formVersionReadAccessRevisions)
          .values({
            formVersionId: version.id,
            revision: (previous?.revision ?? 0) + 1,
            readGrantsJson: JSON.stringify(input.data.readGrants),
            actorId: req.user!.id,
            reason: input.data.reason,
          })
          .returning();
        await transaction
          .insert(activityLogs)
          .values({
            userName: req.user!.name,
            userRole: req.user!.role,
            action: "Updated",
            module: "Form Builder",
            description: `Read access corrected for v${version.version}: ${input.data.reason}`,
            severity: "success",
            metadataJson: JSON.stringify({
              actorId: req.user!.id,
              operation: "form_version_read_access_corrected",
              formDefinitionId: version.formDefinitionId,
              formVersionId: version.id,
              revision: revision.revision,
              previousReadGrants: previous?.readGrants ?? {},
              readGrants: input.data.readGrants,
            }),
          });
        return {
          status: 200,
          revision: revision.revision,
          readGrants: input.data.readGrants,
        };
      });
      res.status(result.status).json(result);
    } catch (error) {
      logger.error({ error }, "Unable to correct form read access");
      res.status(500).json({ error: "Unable to save read correction" });
    }
  },
);
