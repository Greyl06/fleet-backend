import { Router, Request, Response } from "express";
import { and, asc, eq, ilike, or } from "drizzle-orm";
import { db } from "../db/connection.js";
import { lovAttributes, lovItems, lovLists } from "../db/schema.js";
import { requirePermission } from "../middleware/auth.js";

export const lovRouter = Router();
lovRouter.use(requirePermission("read", "LovList"));

const parseJson = (
  value: string,
  fallback: Record<string, unknown> | unknown[] = {},
) => {
  try {
    return JSON.parse(value);
  } catch {
    return fallback;
  }
};

lovRouter.get("/lists", async (_req: Request, res: Response) => {
  try {
    res.json(await db.select().from(lovLists).orderBy(asc(lovLists.name)));
  } catch (error) {
    res.status(500).json({ error: (error as Error).message });
  }
});

lovRouter.post(
  "/lists",
  requirePermission("manage", "LovList"),
  async (req: Request, res: Response) => {
    try {
      const {
        code,
        name,
        description = "",
        isSystem = false,
        supportsHierarchy = false,
      } = req.body;
      if (!code || !name)
        return res.status(400).json({ error: "code and name are required" });
      const [list] = await db
        .insert(lovLists)
        .values({ code, name, description, isSystem, supportsHierarchy })
        .returning();
      res.status(201).json(list);
    } catch (error) {
      res.status(400).json({ error: (error as Error).message });
    }
  },
);

lovRouter.get("/lists/:code", async (req: Request, res: Response) => {
  try {
    const [list] = await db
      .select()
      .from(lovLists)
      .where(eq(lovLists.code, String(req.params.code)));
    if (!list) return res.status(404).json({ error: "LOV list not found" });
    const attributes = await db
      .select()
      .from(lovAttributes)
      .where(eq(lovAttributes.listId, list.id))
      .orderBy(asc(lovAttributes.sortOrder));
    res.json({
      ...list,
      attributes: attributes.map((attribute) => ({
        ...attribute,
        options: parseJson(attribute.optionsJson, []),
      })),
    });
  } catch (error) {
    res.status(500).json({ error: (error as Error).message });
  }
});

lovRouter.put(
  "/lists/:id",
  requirePermission("manage", "LovList"),
  async (req: Request, res: Response) => {
    try {
      const [list] = await db
        .update(lovLists)
        .set({
          name: req.body.name,
          description: req.body.description,
          supportsHierarchy: req.body.supportsHierarchy,
          status: req.body.status,
          updatedAt: new Date(),
        })
        .where(eq(lovLists.id, String(req.params.id)))
        .returning();
      if (!list) return res.status(404).json({ error: "LOV list not found" });
      res.json(list);
    } catch (error) {
      res.status(400).json({ error: (error as Error).message });
    }
  },
);

lovRouter.get("/lists/:code/items", async (req: Request, res: Response) => {
  try {
    const [list] = await db
      .select()
      .from(lovLists)
      .where(eq(lovLists.code, String(req.params.code)));
    if (!list) return res.status(404).json({ error: "LOV list not found" });
    const conditions = [eq(lovItems.listId, list.id)];
    if (req.query.status)
      conditions.push(
        eq(lovItems.status, String(req.query.status) as "active" | "inactive"),
      );
    if (req.query.parentId)
      conditions.push(eq(lovItems.parentId, String(req.query.parentId)));
    if (req.query.q)
      conditions.push(
        or(
          ilike(lovItems.code, `%${String(req.query.q)}%`),
          ilike(lovItems.label, `%${String(req.query.q)}%`),
        )!,
      );
    const items = await db
      .select()
      .from(lovItems)
      .where(and(...conditions))
      .orderBy(asc(lovItems.sortOrder), asc(lovItems.label));
    res.json(
      items.map((item) => ({ ...item, attrs: parseJson(item.attrsJson) })),
    );
  } catch (error) {
    res.status(500).json({ error: (error as Error).message });
  }
});

lovRouter.post(
  "/lists/:code/items",
  requirePermission("manage", "LovList"),
  async (req: Request, res: Response) => {
    try {
      const [list] = await db
        .select()
        .from(lovLists)
        .where(eq(lovLists.code, String(req.params.code)));
      if (!list) return res.status(404).json({ error: "LOV list not found" });
      const {
        code,
        label,
        parentId = null,
        sortOrder = 0,
        status = "active",
        effectiveFrom,
        effectiveTo,
        attrs = {},
      } = req.body;
      if (!code || !label)
        return res.status(400).json({ error: "code and label are required" });
      const [item] = await db
        .insert(lovItems)
        .values({
          listId: list.id,
          code,
          label,
          parentId,
          sortOrder,
          status,
          effectiveFrom: effectiveFrom ? new Date(effectiveFrom) : null,
          effectiveTo: effectiveTo ? new Date(effectiveTo) : null,
          attrsJson: JSON.stringify(attrs),
        })
        .returning();
      res.status(201).json({ ...item, attrs: parseJson(item.attrsJson) });
    } catch (error) {
      res.status(400).json({ error: (error as Error).message });
    }
  },
);

lovRouter.put(
  "/items/:id",
  requirePermission("manage", "LovList"),
  async (req: Request, res: Response) => {
    try {
      const {
        code,
        label,
        parentId,
        sortOrder,
        status,
        effectiveFrom,
        effectiveTo,
        attrs,
      } = req.body;
      const [item] = await db
        .update(lovItems)
        .set({
          code,
          label,
          parentId,
          sortOrder,
          status,
          effectiveFrom: effectiveFrom ? new Date(effectiveFrom) : undefined,
          effectiveTo: effectiveTo ? new Date(effectiveTo) : undefined,
          attrsJson: attrs === undefined ? undefined : JSON.stringify(attrs),
          updatedAt: new Date(),
        })
        .where(eq(lovItems.id, String(req.params.id)))
        .returning();
      if (!item) return res.status(404).json({ error: "LOV item not found" });
      res.json({ ...item, attrs: parseJson(item.attrsJson) });
    } catch (error) {
      res.status(400).json({ error: (error as Error).message });
    }
  },
);

lovRouter.delete(
  "/items/:id",
  requirePermission("manage", "LovList"),
  async (req: Request, res: Response) => {
    try {
      const [item] = await db
        .update(lovItems)
        .set({ status: "inactive", updatedAt: new Date() })
        .where(eq(lovItems.id, String(req.params.id)))
        .returning();
      if (!item) return res.status(404).json({ error: "LOV item not found" });
      res.json({ ...item, attrs: parseJson(item.attrsJson) });
    } catch (error) {
      res.status(500).json({ error: (error as Error).message });
    }
  },
);

lovRouter.get(
  "/lists/:code/attributes",
  async (req: Request, res: Response) => {
    try {
      const [list] = await db
        .select()
        .from(lovLists)
        .where(eq(lovLists.code, String(req.params.code)));
      if (!list) return res.status(404).json({ error: "LOV list not found" });
      const attributes = await db
        .select()
        .from(lovAttributes)
        .where(eq(lovAttributes.listId, list.id))
        .orderBy(asc(lovAttributes.sortOrder));
      res.json(
        attributes.map((attribute) => ({
          ...attribute,
          options: parseJson(attribute.optionsJson, []),
        })),
      );
    } catch (error) {
      res.status(500).json({ error: (error as Error).message });
    }
  },
);

lovRouter.post(
  "/lists/:code/attributes",
  requirePermission("manage", "LovList"),
  async (req: Request, res: Response) => {
    try {
      const [list] = await db
        .select()
        .from(lovLists)
        .where(eq(lovLists.code, String(req.params.code)));
      if (!list) return res.status(404).json({ error: "LOV list not found" });
      const {
        key,
        label,
        type = "text",
        required = false,
        showInGrid = true,
        sortOrder = 0,
        options = [],
      } = req.body;
      if (!key || !label)
        return res.status(400).json({ error: "key and label are required" });
      const [attribute] = await db
        .insert(lovAttributes)
        .values({
          listId: list.id,
          key,
          label,
          type,
          required,
          showInGrid,
          sortOrder,
          optionsJson: JSON.stringify(options),
        })
        .returning();
      res.status(201).json({ ...attribute, options });
    } catch (error) {
      res.status(400).json({ error: (error as Error).message });
    }
  },
);

lovRouter.put(
  "/attributes/:id",
  requirePermission("manage", "LovList"),
  async (req: Request, res: Response) => {
    try {
      const { key, label, type, required, showInGrid, sortOrder, options } =
        req.body;
      const [attribute] = await db
        .update(lovAttributes)
        .set({
          key,
          label,
          type,
          required,
          showInGrid,
          sortOrder,
          optionsJson:
            options === undefined ? undefined : JSON.stringify(options),
        })
        .where(eq(lovAttributes.id, String(req.params.id)))
        .returning();
      if (!attribute)
        return res.status(404).json({ error: "LOV attribute not found" });
      res.json({ ...attribute, options: parseJson(attribute.optionsJson, []) });
    } catch (error) {
      res.status(400).json({ error: (error as Error).message });
    }
  },
);

lovRouter.delete(
  "/attributes/:id",
  requirePermission("manage", "LovList"),
  async (req: Request, res: Response) => {
    try {
      const [attribute] = await db
        .delete(lovAttributes)
        .where(eq(lovAttributes.id, String(req.params.id)))
        .returning();
      if (!attribute)
        return res.status(404).json({ error: "LOV attribute not found" });
      res.json({ id: attribute.id });
    } catch (error) {
      res.status(500).json({ error: (error as Error).message });
    }
  },
);
