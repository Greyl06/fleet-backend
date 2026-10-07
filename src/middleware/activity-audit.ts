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

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function actionForRequest(
  method: string,
  path: string,
  body?: unknown,
): string {
  if (method === "DELETE") return "Deleted";
  if (/\/transition(\/|$)/i.test(path) && isRecord(body)) {
    const target = body.toStage;
    const transitionActions: Record<string, string> = {
      returned: "Returned",
      rejected: "Rejected",
      cancelled: "Cancelled",
      completed: "Completed",
      submitted: "Resubmitted",
      approved: "Approved",
    };
    if (typeof target === "string") return transitionActions[target] ?? "Updated";
  }
  if (/\/(approve|endorse)(\/|$)/i.test(path)) {
    return isRecord(body) && body.action === "reject" ? "Rejected" : "Approved";
  }
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
  const action = actionForRequest(method, path, req.body);
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
