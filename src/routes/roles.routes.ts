import { Router, Request, Response } from "express";
import { db } from "../db/connection.js";
import { roles, permissions, rolePermissions, roleLoginRedirects } from "../db/schema.js";
import { mapInternalRole, type Role } from "../auth/abilities.js";
import { defaultLandingPages, effectiveLandingPage, permittedLandingPages, roleRedirectInput } from "../domain/role-navigation.js";
import { resolveLandingPage } from "../services/role-navigation.service.js";
import { requirePermission } from "../middleware/auth.js";

export const rolesRouter = Router();

rolesRouter.get("/login-redirects/me", async (req, res) => {
  if (!req.user) { res.status(401).json({ error: "Authentication required." }); return; }
  try { res.setHeader("Cache-Control", "no-store"); res.json({ landingPage: await resolveLandingPage(req.user.role) }); }
  catch { res.status(503).json({ error: "Unable to resolve role landing page." }); }
});

rolesRouter.get("/login-redirects", requirePermission("manage", "all"), async (_req, res) => {
  try {
    const saved = await db.select().from(roleLoginRedirects);
    res.setHeader("Cache-Control", "no-store");
    res.json((Object.keys(defaultLandingPages) as Role[]).map((role) => ({
      role, label: role === "admin" ? "System Administrator" : role.replace(/_/g, " "),
      landingPage: effectiveLandingPage(role, saved.find((row) => row.roleKey === role)?.landingPage), options: permittedLandingPages(role),
    })));
  } catch { res.status(500).json({ error: "Unable to load role landing pages." }); }
});

rolesRouter.patch("/login-redirects/:role", requirePermission("manage", "all"), async (req, res) => {
  const role = mapInternalRole(String(req.params.role));
  if (!role) { res.status(404).json({ error: "Unsupported role." }); return; }
  const parsed = roleRedirectInput.safeParse(req.body);
  if (!parsed.success || !permittedLandingPages(role).some((page) => page.path === parsed.data.landingPage)) {
    res.status(400).json({ error: "Select an existing page permitted for this role." }); return;
  }
  try {
    await db.insert(roleLoginRedirects).values({ roleKey: role, landingPage: parsed.data.landingPage, updatedById: req.user!.id }).onConflictDoUpdate({
      target: roleLoginRedirects.roleKey, set: { landingPage: parsed.data.landingPage, updatedById: req.user!.id, updatedAt: new Date() },
    });
    res.locals.roleRedirectAudit = { roleKey: role, landingPage: parsed.data.landingPage };
    res.json({ landingPage: parsed.data.landingPage });
  } catch { res.status(500).json({ error: "Unable to save role landing page." }); }
});

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
