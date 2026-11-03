import { Router, Request, Response } from "express";
import { and, desc, eq, inArray } from "drizzle-orm";
import { db } from "../db/connection.js";
import { activityLogs } from "../db/schema.js";
import { requirePermission } from "../middleware/auth.js";
import { sendError } from "../http/errors.js";
import { parseOffsetPage, setPaginationHeaders } from "./pagination.js";

export const activityLogRouter = Router();

activityLogRouter.get(
  "/",
  requirePermission("read", "AuditLog"),
  async (req: Request, res: Response) => {
    try {
      const conditions = [];
      const module = req.query.module;
      const severity = req.query.severity;
      const action = req.query.action;

      if (typeof module === "string" && module && module !== "all") {
        conditions.push(eq(activityLogs.module, module));
      }

      if (typeof severity === "string" && severity && severity !== "all") {
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

      if (typeof action === "string" && action && action !== "all") {
        conditions.push(eq(activityLogs.action, action));
      }

      const hasPagination =
        req.query.limit !== undefined || req.query.offset !== undefined;
      const page = hasPagination ? parseOffsetPage(req.query) : null;
      if (hasPagination && !page) {
        res.status(400).json({ error: "Invalid pagination parameters." });
        return;
      }

      const limit = page ? page.limit : 500;
      const offset = page ? page.offset : 0;

      const logs = await db
        .select()
        .from(activityLogs)
        .where(conditions.length ? and(...conditions) : undefined)
        .orderBy(desc(activityLogs.createdAt))
        .limit(limit)
        .offset(offset);

      if (page) {
        setPaginationHeaders(res, page, logs.length === limit);
      }

      res.json(logs);
    } catch (err: unknown) {
      sendError(res, err);
    }
  },
);

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
      sendError(res, err);
    }
  },
);

activityLogRouter.delete(
  "/",
  requirePermission("manage", "all"),
  async (req: Request, res: Response) => {
    try {
      const { ids } = req.body ?? {};
      if (!Array.isArray(ids) || ids.length === 0) {
        res.status(400).json({ error: "ids array is required." });
        return;
      }
      const validIds = ids.filter(
        (id): id is string => typeof id === "string" && id.trim().length > 0,
      );
      if (validIds.length === 0) {
        res.status(400).json({ error: "No valid ids provided." });
        return;
      }
      const deleted = await db
        .delete(activityLogs)
        .where(inArray(activityLogs.id, validIds))
        .returning({ id: activityLogs.id });
      res.json({
        message: `${deleted.length} activity log(s) deleted successfully.`,
        deletedCount: deleted.length,
        deletedIds: deleted.map((d) => d.id),
      });
    } catch (err: unknown) {
      sendError(res, err);
    }
  },
);

activityLogRouter.post(
  "/bulk-delete",
  requirePermission("manage", "all"),
  async (req: Request, res: Response) => {
    try {
      const { ids } = req.body ?? {};
      if (!Array.isArray(ids) || ids.length === 0) {
        res.status(400).json({ error: "ids array is required." });
        return;
      }
      const validIds = ids.filter(
        (id): id is string => typeof id === "string" && id.trim().length > 0,
      );
      if (validIds.length === 0) {
        res.status(400).json({ error: "No valid ids provided." });
        return;
      }
      const deleted = await db
        .delete(activityLogs)
        .where(inArray(activityLogs.id, validIds))
        .returning({ id: activityLogs.id });
      res.json({
        message: `${deleted.length} activity log(s) deleted successfully.`,
        deletedCount: deleted.length,
        deletedIds: deleted.map((d) => d.id),
      });
    } catch (err: unknown) {
      sendError(res, err);
    }
  },
);

activityLogRouter.delete(
  "/:id",
  requirePermission("manage", "all"),
  async (req: Request, res: Response) => {
    try {
      const id = String(req.params.id);
      const [deleted] = await db
        .delete(activityLogs)
        .where(eq(activityLogs.id, id))
        .returning({ id: activityLogs.id });
      if (!deleted) {
        res.status(404).json({ error: "Activity log not found." });
        return;
      }
      res.json({ message: "Activity log deleted successfully.", id: deleted.id });
    } catch (err: unknown) {
      sendError(res, err);
    }
  },
);
