import { Router, Request, Response } from "express";
import { eq } from "drizzle-orm";
import { db } from "../db/connection.js";
import {
  departments,
  vehicleTypes,
  maintenanceCategories,
  vendors,
} from "../db/schema.js";
import { requirePermission } from "../middleware/auth.js";

export const referenceDataRouter = Router();

referenceDataRouter.use((req, res, next) => {
  if (["GET", "HEAD", "OPTIONS"].includes(req.method)) return next();
  return requirePermission("manage", "LovList")(req, res, next);
});

// ==========================================
// DEPARTMENTS
// ==========================================
referenceDataRouter.get(
  "/departments",
  async (_req: Request, res: Response) => {
    try {
      const list = await db.select().from(departments);
      res.json(list);
    } catch (err: unknown) {
      const error = err as Error;
      res.status(500).json({ error: error.message });
    }
  },
);

referenceDataRouter.post(
  "/departments",
  async (req: Request, res: Response) => {
    try {
      const { code, name, head, isActive } = req.body;
      const [item] = await db
        .insert(departments)
        .values({
          code,
          name,
          head: head || "",
          isActive: isActive !== undefined ? isActive : true,
        })
        .returning();
      res.status(201).json(item);
    } catch (err: unknown) {
      const error = err as Error;
      res.status(400).json({ error: error.message });
    }
  },
);

referenceDataRouter.put(
  "/departments/:id",
  async (req: Request, res: Response) => {
    try {
      const { code, name, head, isActive } = req.body;
      const [updated] = await db
        .update(departments)
        .set({ code, name, head, isActive })
        .where(eq(departments.id, String(req.params.id)))
        .returning();
      if (!updated)
        return res.status(404).json({ error: "Department not found" });
      res.json(updated);
    } catch (err: unknown) {
      const error = err as Error;
      res.status(400).json({ error: error.message });
    }
  },
);

referenceDataRouter.delete(
  "/departments/:id",
  async (req: Request, res: Response) => {
    try {
      await db
        .delete(departments)
        .where(eq(departments.id, String(req.params.id)));
      res.json({
        message: "Department deleted successfully",
        id: String(req.params.id),
      });
    } catch (err: unknown) {
      const error = err as Error;
      res.status(500).json({ error: error.message });
    }
  },
);

// ==========================================
// VEHICLE TYPES
// ==========================================
referenceDataRouter.get(
  "/vehicle-types",
  async (_req: Request, res: Response) => {
    try {
      const list = await db.select().from(vehicleTypes);
      res.json(list);
    } catch (err: unknown) {
      const error = err as Error;
      res.status(500).json({ error: error.message });
    }
  },
);

referenceDataRouter.post(
  "/vehicle-types",
  async (req: Request, res: Response) => {
    try {
      const { code, label, category, pmsIntervalKm, isActive } = req.body;
      const [item] = await db
        .insert(vehicleTypes)
        .values({
          code,
          label,
          category: category || "medium",
          pmsIntervalKm: pmsIntervalKm || 5000,
          isActive: isActive !== undefined ? isActive : true,
        })
        .returning();
      res.status(201).json(item);
    } catch (err: unknown) {
      const error = err as Error;
      res.status(400).json({ error: error.message });
    }
  },
);

referenceDataRouter.put(
  "/vehicle-types/:id",
  async (req: Request, res: Response) => {
    try {
      const { code, label, category, pmsIntervalKm, isActive } = req.body;
      const [updated] = await db
        .update(vehicleTypes)
        .set({ code, label, category, pmsIntervalKm, isActive })
        .where(eq(vehicleTypes.id, String(req.params.id)))
        .returning();
      if (!updated)
        return res.status(404).json({ error: "Vehicle type not found" });
      res.json(updated);
    } catch (err: unknown) {
      const error = err as Error;
      res.status(400).json({ error: error.message });
    }
  },
);

referenceDataRouter.delete(
  "/vehicle-types/:id",
  async (req: Request, res: Response) => {
    try {
      await db
        .delete(vehicleTypes)
        .where(eq(vehicleTypes.id, String(req.params.id)));
      res.json({
        message: "Vehicle type deleted successfully",
        id: String(req.params.id),
      });
    } catch (err: unknown) {
      const error = err as Error;
      res.status(500).json({ error: error.message });
    }
  },
);

// ==========================================
// MAINTENANCE CATEGORIES
// ==========================================
referenceDataRouter.get(
  "/maintenance-categories",
  async (_req: Request, res: Response) => {
    try {
      const list = await db.select().from(maintenanceCategories);
      res.json(list);
    } catch (err: unknown) {
      const error = err as Error;
      res.status(500).json({ error: error.message });
    }
  },
);

referenceDataRouter.post(
  "/maintenance-categories",
  async (req: Request, res: Response) => {
    try {
      const { code, name, description, isActive } = req.body;
      const [item] = await db
        .insert(maintenanceCategories)
        .values({
          code,
          name,
          description: description || "",
          isActive: isActive !== undefined ? isActive : true,
        })
        .returning();
      res.status(201).json(item);
    } catch (err: unknown) {
      const error = err as Error;
      res.status(400).json({ error: error.message });
    }
  },
);

referenceDataRouter.put(
  "/maintenance-categories/:id",
  async (req: Request, res: Response) => {
    try {
      const { code, name, description, isActive } = req.body;
      const [updated] = await db
        .update(maintenanceCategories)
        .set({ code, name, description, isActive })
        .where(eq(maintenanceCategories.id, String(req.params.id)))
        .returning();
      if (!updated)
        return res.status(404).json({ error: "Category not found" });
      res.json(updated);
    } catch (err: unknown) {
      const error = err as Error;
      res.status(400).json({ error: error.message });
    }
  },
);

referenceDataRouter.delete(
  "/maintenance-categories/:id",
  async (req: Request, res: Response) => {
    try {
      await db
        .delete(maintenanceCategories)
        .where(eq(maintenanceCategories.id, String(req.params.id)));
      res.json({
        message: "Category deleted successfully",
        id: String(req.params.id),
      });
    } catch (err: unknown) {
      const error = err as Error;
      res.status(500).json({ error: error.message });
    }
  },
);

// ==========================================
// VENDORS
// ==========================================
referenceDataRouter.get("/vendors", async (_req: Request, res: Response) => {
  try {
    const list = await db.select().from(vendors);
    res.json(list);
  } catch (err: unknown) {
    const error = err as Error;
    res.status(500).json({ error: error.message });
  }
});

referenceDataRouter.post("/vendors", async (req: Request, res: Response) => {
  try {
    const { name, contactPerson, phone, specialization, isActive } = req.body;
    const [item] = await db
      .insert(vendors)
      .values({
        name,
        contactPerson: contactPerson || "",
        phone: phone || "",
        specialization: specialization || "",
        isActive: isActive !== undefined ? isActive : true,
      })
      .returning();
    res.status(201).json(item);
  } catch (err: unknown) {
    const error = err as Error;
    res.status(400).json({ error: error.message });
  }
});

referenceDataRouter.put("/vendors/:id", async (req: Request, res: Response) => {
  try {
    const { name, contactPerson, phone, specialization, isActive } = req.body;
    const [updated] = await db
      .update(vendors)
      .set({ name, contactPerson, phone, specialization, isActive })
      .where(eq(vendors.id, String(req.params.id)))
      .returning();
    if (!updated) return res.status(404).json({ error: "Vendor not found" });
    res.json(updated);
  } catch (err: unknown) {
    const error = err as Error;
    res.status(400).json({ error: error.message });
  }
});

referenceDataRouter.delete(
  "/vendors/:id",
  async (req: Request, res: Response) => {
    try {
      await db.delete(vendors).where(eq(vendors.id, String(req.params.id)));
      res.json({
        message: "Vendor deleted successfully",
        id: String(req.params.id),
      });
    } catch (err: unknown) {
      const error = err as Error;
      res.status(500).json({ error: error.message });
    }
  },
);
