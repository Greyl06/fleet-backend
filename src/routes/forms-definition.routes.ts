import { Router, Request, Response } from "express";
import {
  and,
  asc,
  desc,
  eq,
  inArray,
  max,
  or,
  sql,
} from "drizzle-orm";
import { db } from "../db/connection.js";
import {
  formDefinitions,
  formSubmissions,
  formVersions,
  lovLists,
} from "../db/schema.js";
import { requirePermission } from "../middleware/auth.js";
import {
  validateFormSchema,
  validateFormWorkflow,
} from "../domain/form-definition.js";
import { restrictedRequesterStages } from "../domain/submission-access.js";
import {
  isRecord,
  parseJson,
  recordFormBuilderActivity,
  schemaFieldKeys,
} from "./forms-common.js";

export const formsDefinitionRouter = Router();

formsDefinitionRouter.get(
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
          publishedAt: formVersions.publishedAt,
          publishedBy: formVersions.publishedBy,
          createdAt: formVersions.createdAt,
          updatedAt: formVersions.updatedAt,
        })
        .from(formVersions)
        .orderBy(desc(formVersions.version));

      const results = allDefinitions.map((def) => {
        const versions = allVersions.filter(
          (v) => v.formDefinitionId === def.id,
        );
        const publishedVersion = versions.find((v) => v.status === "published");
        const draftVersion = versions.find((v) => v.status === "draft");

        return {
          id: def.id,
          key: def.key,
          name: def.name,
          createdAt: def.createdAt,
          updatedAt: def.updatedAt,
          publishedVersion: publishedVersion ? publishedVersion.version : null,
          hasDraft: !!draftVersion,
          versionsCount: versions.length,
          versions,
        };
      });

      res.json(results);
    } catch (error) {
      res.status(500).json({ error: (error as Error).message });
    }
  },
);

formsDefinitionRouter.get("/published/:key", async (req: Request, res: Response) => {
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

formsDefinitionRouter.get(
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

formsDefinitionRouter.post(
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
          .json({
            error: `A form with key "${normalizedKey}" already exists.`,
          });
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
        .json({
          ...definition,
          version: {
            ...version,
            versionName: resolvedVersionName,
            schema: nextSchema,
            workflow,
          },
        });
    } catch (error) {
      res.status(400).json({ error: (error as Error).message });
    }
  },
);

formsDefinitionRouter.post(
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
          formDefinitionId: targetDefinition.id,
          version: nextVersion,
          versionName: resolvedVersionName,
          schemaJson: JSON.stringify(nextSchema),
          workflowJson: JSON.stringify(workflow),
          status: "draft",
        })
        .returning();
      await recordFormBuilderActivity(req, {
        action: "Created",
        operation: "form_version_created",
        description: `Created draft v${version.version} for form "${resolvedFormName}" (${targetDefinition.key}).`,
        formDefinitionId: targetDefinition.id,
        formKey: targetDefinition.key,
        formName: resolvedFormName,
        formVersion: version.version,
      });
      res.status(201).json({
        ...version,
        versionName: resolvedVersionName,
        schema: nextSchema,
        workflow,
      });
    } catch (error) {
      const message =
        (error as any)?.cause?.message || (error as Error).message;
      res.status(400).json({ error: message });
    }
  },
);

formsDefinitionRouter.put(
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
      res.json({
        ...version,
        versionName: resolvedVersionName,
        schema: nextSchema,
        workflow: nextWorkflow,
      });
    } catch (error) {
      res.status(400).json({ error: (error as Error).message });
    }
  },
);

formsDefinitionRouter.patch(
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

      const { versionName } = req.body;
      const resolvedVersionName =
        typeof versionName === "string" && versionName.trim()
          ? versionName.trim()
          : null;

      let nextSchemaJson = targetVersion.schemaJson;
      try {
        const parsed = parseJson(targetVersion.schemaJson);
        if (isRecord(parsed)) {
          if (resolvedVersionName) {
            parsed.versionName = resolvedVersionName;
          } else {
            delete parsed.versionName;
          }
          nextSchemaJson = JSON.stringify(parsed);
        }
      } catch {
        // preserve schemaJson as is
      }

      const [updated] = await db
        .update(formVersions)
        .set({
          versionName: resolvedVersionName,
          schemaJson: nextSchemaJson,
          updatedAt: new Date(),
        })
        .where(eq(formVersions.id, targetVersion.id))
        .returning();

      const [definition] = await db
        .select()
        .from(formDefinitions)
        .where(eq(formDefinitions.id, targetVersion.formDefinitionId));

      if (definition) {
        await recordFormBuilderActivity(req, {
          action: "Updated",
          operation: "form_version_name_updated",
          description: `Updated release label on v${targetVersion.version} of form "${definition.name}" to "${resolvedVersionName ?? "None"}".`,
          formDefinitionId: definition.id,
          formKey: definition.key,
          formName: definition.name,
          formVersion: targetVersion.version,
        });
      }

      res.json({
        ...updated,
        versionName: resolvedVersionName,
      });
    } catch (error) {
      res.status(400).json({ error: (error as Error).message });
    }
  },
);

formsDefinitionRouter.patch(
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

      const { name } = req.body;
      if (typeof name !== "string" || !name.trim()) {
        return res
          .status(400)
          .json({ error: "A valid form name is required." });
      }

      const trimmedName = name.trim();
      const [updated] = await db
        .update(formDefinitions)
        .set({ name: trimmedName, updatedAt: new Date() })
        .where(eq(formDefinitions.id, definition.id))
        .returning();

      await recordFormBuilderActivity(req, {
        action: "Updated",
        operation: "form_definition_renamed",
        description: `Renamed form template from "${definition.name}" to "${trimmedName}" (${definition.key}).`,
        formDefinitionId: definition.id,
        formKey: definition.key,
        formName: trimmedName,
        formVersion: 0,
      });

      res.json(updated);
    } catch (error) {
      res.status(400).json({ error: (error as Error).message });
    }
  },
);

formsDefinitionRouter.delete(
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

      await db
        .delete(formVersions)
        .where(eq(formVersions.id, targetVersion.id));

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

formsDefinitionRouter.delete(
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
          error:
            "The core TSRF form template is protected and cannot be deleted.",
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

formsDefinitionRouter.post(
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
          if (!isRecord(stage) || !isRecord(stage.fieldPermissions))
            return stage;
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
            if (!isRecord(trans) || !Array.isArray(trans.requiredFields))
              return trans;
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
      const restrictedStages = restrictedRequesterStages(
        schema,
        activeWorkflow,
      );
      const acknowledged = Array.isArray(req.body?.acknowledgeRestrictedStages)
        ? req.body.acknowledgeRestrictedStages
        : [];
      if (restrictedStages.some((stage) => !acknowledged.includes(stage)))
        return res
          .status(422)
          .json({
            error:
              "Requestor read access is incomplete. Configure stage permissions or acknowledge the restricted stages.",
            code: "RESTRICTED_STAGE_ACCESS",
            restrictedStages,
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
      const published = await db.transaction(async (transaction) => {
        await transaction
          .select({ id: formDefinitions.id })
          .from(formDefinitions)
          .where(eq(formDefinitions.id, draft.formDefinitionId))
          .for("update");
        const [currentPublished] = await transaction
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
        if (currentPublished?.schemaJson !== publishedVersion?.schemaJson)
          return null;
        const [currentDraft] = await transaction
          .select()
          .from(formVersions)
          .where(eq(formVersions.id, draft.id))
          .for("update");
        if (
          currentDraft.status !== "draft" ||
          currentDraft.schemaJson !== draft.schemaJson ||
          JSON.stringify(parseJson(currentDraft.workflowJson)) !==
            JSON.stringify(activeWorkflow)
        )
          return null;
        await transaction
          .update(formVersions)
          .set({ status: "archived", updatedAt: new Date() })
          .where(
            and(
              eq(formVersions.formDefinitionId, draft.formDefinitionId),
              eq(formVersions.status, "published"),
            ),
          );
        const [next] = await transaction
          .update(formVersions)
          .set({
            status: "published",
            publishedBy: req.user?.name ?? "system",
            publishedAt: new Date(),
            updatedAt: new Date(),
          })
          .where(eq(formVersions.id, draft.id))
          .returning();
        return next;
      });
      if (!published)
        return res
          .status(409)
          .json({ error: "Draft changed; reload before publishing." });
      const retiredSuffix =
        retiredKeysList.length > 0
          ? ` (retired fields: ${retiredKeysList.join(", ")})`
          : "";
      await recordFormBuilderActivity(req, {
        action: "Published",
        operation: "form_version_published",
        description: `Published v${published.version} of form "${publishedFormName}" (${definition.key})${retiredSuffix}. Restricted stages acknowledged: ${restrictedStages.join(", ") || "none"}.`,
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

formsDefinitionRouter.post(
  "/versions/:id/activate",
  requirePermission("manage", "FormDefinition"),
  async (req: Request, res: Response) => {
    try {
      const isUuid =
        /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(
          String(req.params.id),
        );
      const [targetVersion] = await db
        .select()
        .from(formVersions)
        .where(
          isUuid
            ? eq(formVersions.id, String(req.params.id))
            : eq(formVersions.version, Number(req.params.id)),
        );
      if (!targetVersion)
        return res.status(404).json({ error: "Form version not found" });

      const [definition] = await db
        .select()
        .from(formDefinitions)
        .where(eq(formDefinitions.id, targetVersion.formDefinitionId));
      if (!definition)
        return res.status(404).json({ error: "Form definition not found" });

      const schema = parseJson(targetVersion.schemaJson);
      const formTitle =
        typeof schema.name === "string" && schema.name.trim()
          ? schema.name.trim()
          : definition.name;

      const activated = await db.transaction(async (transaction) => {
        await transaction
          .select({ id: formDefinitions.id })
          .from(formDefinitions)
          .where(eq(formDefinitions.id, targetVersion.formDefinitionId))
          .for("update");

        // Archive any currently published versions for this form
        await transaction
          .update(formVersions)
          .set({ status: "archived", updatedAt: new Date() })
          .where(
            and(
              eq(formVersions.formDefinitionId, targetVersion.formDefinitionId),
              eq(formVersions.status, "published"),
            ),
          );

        // Promote the target version to published
        const [next] = await transaction
          .update(formVersions)
          .set({
            status: "published",
            publishedBy: req.user?.name ?? "system",
            publishedAt: new Date(),
            updatedAt: new Date(),
          })
          .where(eq(formVersions.id, targetVersion.id))
          .returning();

        // Update master form template name if needed
        if (formTitle !== definition.name) {
          await transaction
            .update(formDefinitions)
            .set({ name: formTitle, updatedAt: new Date() })
            .where(eq(formDefinitions.id, definition.id));
        }

        return next;
      });

      await recordFormBuilderActivity(req, {
        action: "Activated",
        operation: "form_version_activated",
        description: `Set version v${activated.version} of form "${formTitle}" (${definition.key}) as active.`,
        formDefinitionId: definition.id,
        formKey: definition.key,
        formName: formTitle,
        formVersion: activated.version,
      });

      res.json({
        ...activated,
        versionName: activated.versionName ?? schema.versionName ?? null,
        schema: parseJson(activated.schemaJson),
        workflow: parseJson(activated.workflowJson),
      });
    } catch (error) {
      res.status(400).json({ error: (error as Error).message });
    }
  },
);
