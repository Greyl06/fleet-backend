import { Router, Request, Response } from "express";
import { and, desc, eq, max } from "drizzle-orm";
import { db } from "../db/connection.js";
import { formDefinitions, formVersions, lovLists } from "../db/schema.js";
import { requirePermission } from "../middleware/auth.js";
import { validateFormSchema } from "../domain/form-definition.js";

export const formsRouter = Router();

const parseJson = (value: string) => {
  try {
    return JSON.parse(value);
  } catch {
    return {};
  }
};

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
      const validationErrors = validateFormSchema(
        parseJson(draft.schemaJson),
        new Set(availableLists.map((list) => list.code)),
      );
      if (validationErrors.length > 0)
        return res
          .status(422)
          .json({
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
