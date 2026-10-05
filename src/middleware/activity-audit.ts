import type { NextFunction, Request, Response } from "express";
import { db } from "../db/connection.js";
import { activityLogs } from "../db/schema.js";
import { logger } from "../config/logger.js";

const MUTATING_METHODS = new Set(["POST", "PUT", "PATCH", "DELETE"]);

function moduleForPath(path: string): string {
  if (path.startsWith("/api/vehicles")) return "Fleet";
  if (path.startsWith("/api/tsrf")) return "TSRF";
  if (path.startsWith("/api/forms")) return "TSRF";
  if (path.startsWith("/api/maintenance")) return "Maintenance";
  if (path.startsWith("/api/procurement")) return "Purchase Requisition";
  if (path.startsWith("/api/users")) return "User Management";
  if (path.startsWith("/api/roles")) return "Roles";
  if (path.startsWith("/api/lov") || path.startsWith("/api/reference-data"))
    return "Reference Data";
  return "System";
}

function actionForRequest(method: string, path: string): string {
  if (method === "DELETE") return "Deleted";
  if (/\/(approve|endorse|transition)(\/|$)/i.test(path)) return "Approved";
  if (
    (path.startsWith("/api/tsrf") || path.startsWith("/api/forms")) &&
    method === "POST"
  )
    return "Submitted";
  if (method === "POST") return "Created";
  return "Updated";
}

export function activityAuditMiddleware(
  req: Request,
  res: Response,
  next: NextFunction,
): void {
  if (
    !MUTATING_METHODS.has(req.method) ||
    req.path.startsWith("/api/auth") ||
    req.path.startsWith("/api/activity-logs") ||
    !req.user
  ) {
    next();
    return;
  }

  const actor = req.user;
  const path = req.path;
  const method = req.method;
  const module = moduleForPath(path);
  const action = actionForRequest(method, path);
  res.once("finish", () => {
    if (res.statusCode < 200 || res.statusCode >= 300) return;
    void db
      .insert(activityLogs)
      .values({
        userName: actor.name,
        userRole: actor.role,
        action,
        module,
        description: `${method} ${path} completed successfully.`,
        severity: "success",
        metadataJson: JSON.stringify({
          actorId: actor.id,
          method,
          path,
          statusCode: res.statusCode,
        }),
      })
      .catch((error: unknown) => {
        logger.error(
          { error, module, action },
          "Unable to persist activity audit event",
        );
      });
  });
  next();
}
