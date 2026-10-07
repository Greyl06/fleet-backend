import { Router, Request, Response } from "express";
import { and, asc, eq } from "drizzle-orm";
import { db } from "../db/connection.js";
import { lovItems, lovLists } from "../db/schema.js";
import { requirePermission } from "../middleware/auth.js";

export const referenceDataRouter = Router();

referenceDataRouter.use((req, res, next) => {
  if (["GET", "HEAD", "OPTIONS"].includes(req.method)) return next();
  return requirePermission("manage", "LovList")(req, res, next);
});

type LovItem = typeof lovItems.$inferSelect;
type CatalogValues = {
  code: string;
  label: string;
  status: "active" | "inactive";
  attrs: Record<string, unknown>;
};

type CatalogAdapter = {
  path: string;
  listCode: string;
  toLegacy: (item: LovItem, attrs: Record<string, unknown>) => Record<string, unknown>;
  fromLegacy: (body: Record<string, unknown>, existing?: LovItem) => CatalogValues;
};

function parseAttrs(value: string): Record<string, unknown> {
  try {
    const parsed: unknown = JSON.parse(value);
    return typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : {};
  } catch {
    return {};
  }
}

function getString(value: unknown, fallback = ""): string {
  return typeof value === "string" ? value.trim() : fallback;
}

function getActiveStatus(body: Record<string, unknown>, existing?: LovItem) {
  if (body.isActive === undefined) return existing?.status ?? "active";
  if (typeof body.isActive !== "boolean") throw new Error("isActive must be a boolean.");
  return body.isActive ? "active" : "inactive";
}

function mergeAttributes(
  body: Record<string, unknown>,
  existing: LovItem | undefined,
  fields: Record<string, string>,
): Record<string, unknown> {
  const attrs = existing ? parseAttrs(existing.attrsJson) : {};
  for (const [legacyKey, lovKey] of Object.entries(fields)) {
    if (body[legacyKey] !== undefined) attrs[lovKey] = body[legacyKey];
  }
  return attrs;
}

function codeFromName(name: string) {
  return name.toUpperCase().replace(/[^A-Z0-9]+/g, "_") || "VENDOR";
}

const catalogs: CatalogAdapter[] = [
  {
    path: "departments",
    listCode: "DEPARTMENTS",
    toLegacy: (item, attrs) => ({
      id: item.id,
      code: item.code,
      name: item.label,
      head: getString(attrs.head),
      isActive: item.status === "active",
      createdAt: item.createdAt,
    }),
    fromLegacy: (body, existing) => ({
      code: getString(body.code, existing?.code ?? ""),
      label: getString(body.name, existing?.label ?? ""),
      status: getActiveStatus(body, existing),
      attrs: mergeAttributes(body, existing, { head: "head" }),
    }),
  },
  {
    path: "vehicle-types",
    listCode: "VEHICLE_TYPES",
    toLegacy: (item, attrs) => ({
      id: item.id,
      code: item.code,
      label: item.label,
      category: getString(attrs.category, "medium"),
      pmsIntervalKm: Number(attrs.pms_interval_km ?? 5000),
      isActive: item.status === "active",
      createdAt: item.createdAt,
    }),
    fromLegacy: (body, existing) => ({
      code: getString(body.code, existing?.code ?? ""),
      label: getString(body.label, existing?.label ?? ""),
      status: getActiveStatus(body, existing),
      attrs: mergeAttributes(body, existing, {
        category: "category",
        pmsIntervalKm: "pms_interval_km",
      }),
    }),
  },
  {
    path: "maintenance-categories",
    listCode: "MAINTENANCE_CATEGORIES",
    toLegacy: (item, attrs) => ({
      id: item.id,
      code: item.code,
      name: item.label,
      description: getString(attrs.description),
      isActive: item.status === "active",
      createdAt: item.createdAt,
    }),
    fromLegacy: (body, existing) => ({
      code: getString(body.code, existing?.code ?? ""),
      label: getString(body.name, existing?.label ?? ""),
      status: getActiveStatus(body, existing),
      attrs: mergeAttributes(body, existing, { description: "description" }),
    }),
  },
  {
    path: "vendors",
    listCode: "VENDORS",
    toLegacy: (item, attrs) => ({
      id: item.id,
      name: item.label,
      contactPerson: getString(attrs.contact_person),
      phone: getString(attrs.phone),
      specialization: getString(attrs.specialization),
      isActive: item.status === "active",
      createdAt: item.createdAt,
    }),
    fromLegacy: (body, existing) => {
      const name = getString(body.name, existing?.label ?? "");
      return {
        code: getString(body.code, existing?.code ?? codeFromName(name)),
        label: name,
        status: getActiveStatus(body, existing),
        attrs: mergeAttributes(body, existing, {
          contactPerson: "contact_person",
          phone: "phone",
          specialization: "specialization",
        }),
      };
    },
  },
];

async function getListId(listCode: string): Promise<string | null> {
  const [list] = await db
    .select({ id: lovLists.id })
    .from(lovLists)
    .where(eq(lovLists.code, listCode));
  return list?.id ?? null;
}

async function listItems(listCode: string) {
  const listId = await getListId(listCode);
  if (!listId) throw new Error(`LOV list ${listCode} not found.`);
  return db
    .select()
    .from(lovItems)
    .where(eq(lovItems.listId, listId))
    .orderBy(asc(lovItems.sortOrder), asc(lovItems.label));
}

async function findItem(listCode: string, id: string): Promise<LovItem | null> {
  const listId = await getListId(listCode);
  if (!listId) return null;
  const [item] = await db
    .select()
    .from(lovItems)
    .where(and(eq(lovItems.listId, listId), eq(lovItems.id, id)));
  return item ?? null;
}

function validateValues(adapter: CatalogAdapter, values: CatalogValues) {
  if (!values.code || !values.label) throw new Error("code and name are required.");
  if (adapter.listCode === "VEHICLE_TYPES") {
    const category = values.attrs.category;
    const interval = values.attrs.pms_interval_km;
    if (!["light", "medium", "heavy", "special"].includes(String(category)))
      throw new Error("category must be light, medium, heavy, or special.");
    if (typeof interval !== "number" || !Number.isFinite(interval) || interval <= 0)
      throw new Error("pmsIntervalKm must be a positive number.");
  }
  for (const [key, value] of Object.entries(values.attrs)) {
    if (typeof value !== "string" && typeof value !== "number" && typeof value !== "boolean")
      throw new Error(`Attribute "${key}" must be a scalar value.`);
  }
}

for (const adapter of catalogs) {
  referenceDataRouter.get(`/${adapter.path}`, async (_req: Request, res: Response) => {
    try {
      const items = await listItems(adapter.listCode);
      res.json(items.map((item) => adapter.toLegacy(item, parseAttrs(item.attrsJson))));
    } catch (error) {
      res.status(500).json({ error: (error as Error).message });
    }
  });

  referenceDataRouter.post(`/${adapter.path}`, async (req: Request, res: Response) => {
    try {
      const listId = await getListId(adapter.listCode);
      if (!listId) return res.status(404).json({ error: "Reference list not found." });
      const values = adapter.fromLegacy(req.body, undefined);
      validateValues(adapter, values);
      const [item] = await db
        .insert(lovItems)
        .values({
          listId,
          code: values.code,
          label: values.label,
          status: values.status,
          attrsJson: JSON.stringify(values.attrs),
        })
        .returning();
      res.status(201).json(adapter.toLegacy(item, values.attrs));
    } catch (error) {
      res.status(400).json({ error: (error as Error).message });
    }
  });

  referenceDataRouter.put(`/${adapter.path}/:id`, async (req: Request, res: Response) => {
    try {
      const existing = await findItem(adapter.listCode, String(req.params.id));
      if (!existing) return res.status(404).json({ error: "Reference item not found." });
      const values = adapter.fromLegacy(req.body, existing);
      validateValues(adapter, values);
      const [item] = await db
        .update(lovItems)
        .set({
          code: values.code,
          label: values.label,
          status: values.status,
          attrsJson: JSON.stringify(values.attrs),
          updatedAt: new Date(),
        })
        .where(eq(lovItems.id, existing.id))
        .returning();
      res.json(adapter.toLegacy(item, values.attrs));
    } catch (error) {
      res.status(400).json({ error: (error as Error).message });
    }
  });

  referenceDataRouter.delete(`/${adapter.path}/:id`, async (req: Request, res: Response) => {
    try {
      const item = await findItem(adapter.listCode, String(req.params.id));
      if (!item) return res.status(404).json({ error: "Reference item not found." });
      await db
        .update(lovItems)
        .set({ status: "inactive", updatedAt: new Date() })
        .where(eq(lovItems.id, item.id));
      res.json({ message: "Reference item deactivated successfully", id: item.id });
    } catch (error) {
      res.status(500).json({ error: (error as Error).message });
    }
  });
}