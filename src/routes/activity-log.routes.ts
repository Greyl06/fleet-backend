import { Router, Request, Response } from "express";
import { and, desc, eq } from "drizzle-orm";
import { db } from "../db/connection.js";
import { activityLogs } from "../db/schema.js";
import { requirePermission } from "../middleware/auth.js";

export const activityLogRouter = Router();

activityLogRouter.get("/", async (req: Request, res: Response) => {
  try {
    const conditions = [];
    const module = req.query.module;
    const severity = req.query.severity;
    if (typeof module === "string" && module)
      conditions.push(eq(activityLogs.module, module));
    if (typeof severity === "string" && severity) {
      const validSeverities = new Set([
        "info",
        "warning",
        "critical",
        "success",
      ]);
      if (!validSeverities.has(severity)) {
        res.status(400).json({ error: "Unknown severity filter." });
        return;
      }
      conditions.push(
        eq(
          activityLogs.severity,
          severity as typeof activityLogs.$inferSelect.severity,
        ),
      );
    }
    const logs = await db
      .select()
      .from(activityLogs)
      .where(conditions.length ? and(...conditions) : undefined)
      .orderBy(desc(activityLogs.createdAt))
      .limit(500);
    res.json(logs);
  } catch (err: unknown) {
    const error = err as Error;
    res.status(500).json({ error: error.message });
  }
});

activityLogRouter.post(
  "/",
  requirePermission("manage", "all"),
  async (req: Request, res: Response) => {
    try {
      const { action, module, description, severity, metadata } = req.body;
      if (
        !req.user ||
        typeof action !== "string" ||
        typeof module !== "string" ||
        typeof description !== "string"
      ) {
        res
          .status(400)
          .json({ error: "action, module, and description are required." });
        return;
      }
      const [created] = await db
        .insert(activityLogs)
        .values({
          userName: req.user.name,
          userRole: req.user.role,
          action,
          module,
          description,
          severity: severity || "info",
          metadataJson: metadata ? JSON.stringify(metadata) : "{}",
        })
        .returning();
      res.status(201).json(created);
    } catch (err: unknown) {
      const error = err as Error;
      res.status(400).json({ error: error.message });
    }
  },
);
