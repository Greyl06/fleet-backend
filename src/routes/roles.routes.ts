import { Router, Request, Response } from "express";
import { db } from "../db/connection.js";
import { roles, permissions, rolePermissions } from "../db/schema.js";
import { requirePermission } from "../middleware/auth.js";

export const rolesRouter = Router();

function rejectUnwiredRolePolicyWrites(_req: Request, res: Response): void {
  res.status(409).json({
    error: "Dynamic role policies are not enabled",
    message:
      "Server authorization uses fixed CASL policies until role management is connected to the policy source.",
  });
}

// GET /api/roles - List all roles with their assigned permission keys
rolesRouter.get("/", async (_req: Request, res: Response) => {
  try {
    const allRoles = await db.select().from(roles);
    const allMappings = await db.select().from(rolePermissions);

    const rolesWithPermissions = allRoles.map((r) => {
      const assigned = allMappings
        .filter((m) => m.roleId === r.id)
        .map((m) => m.permissionKey);
      return {
        ...r,
        permissions: assigned,
      };
    });

    res.json(rolesWithPermissions);
  } catch (err: unknown) {
    const error = err as Error;
    res.status(500).json({ error: error.message });
  }
});

// GET /api/roles/permissions - List all available permissions
rolesRouter.get("/permissions", async (_req: Request, res: Response) => {
  try {
    const allPerms = await db.select().from(permissions);
    res.json(allPerms);
  } catch (err: unknown) {
    const error = err as Error;
    res.status(500).json({ error: error.message });
  }
});

// Role catalog writes stay disabled until they can update authoritative CASL policy.
rolesRouter.post(
  "/permissions",
  requirePermission("manage", "all"),
  rejectUnwiredRolePolicyWrites,
);
rolesRouter.put(
  "/permissions/:key",
  requirePermission("manage", "all"),
  rejectUnwiredRolePolicyWrites,
);
rolesRouter.delete(
  "/permissions/:key",
  requirePermission("manage", "all"),
  rejectUnwiredRolePolicyWrites,
);
rolesRouter.post(
  "/",
  requirePermission("manage", "all"),
  rejectUnwiredRolePolicyWrites,
);
rolesRouter.put(
  "/:id",
  requirePermission("manage", "all"),
  rejectUnwiredRolePolicyWrites,
);
rolesRouter.delete(
  "/:id",
  requirePermission("manage", "all"),
  rejectUnwiredRolePolicyWrites,
);
