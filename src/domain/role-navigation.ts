import { z } from "zod";
import type { Role } from "../auth/abilities.js";

export const defaultLandingPages: Record<Role, string> = {
  admin: "/dashboard", fleet_team: "/fleet", finance: "/procurement", procurement: "/procurement",
  approver: "/tsrf", department_requester: "/tsrf", driver: "/fleet", auditor: "/reports",
};
const allRoles = Object.keys(defaultLandingPages) as Role[];
export const landingPages = [
  { path: "/dashboard", label: "Dashboard", roles: allRoles.filter((role) => role !== "auditor") },
  { path: "/fleet", label: "Fleet & KM Monitoring", roles: ["admin", "fleet_team", "procurement", "driver"] },
  { path: "/tsrf", label: "TSRF Logistics", roles: ["admin", "fleet_team", "approver", "department_requester"] },
  { path: "/procurement", label: "PR Gatekeeper", roles: ["admin", "fleet_team", "procurement", "finance"] },
  { path: "/reports", label: "Reports", roles: allRoles.filter((role) => role !== "procurement") },
  { path: "/users", label: "User Management", roles: ["admin"] },
  { path: "/roles", label: "Roles Management", roles: ["admin"] },
  { path: "/reference-data", label: "Reference Data", roles: ["admin"] },
  { path: "/form-builder", label: "Form Builder", roles: ["admin"] },
  { path: "/history", label: "Activity History", roles: ["admin", "auditor"] },
  { path: "/theme-editor", label: "Theme Editor", roles: allRoles.filter((role) => role !== "auditor") },
] satisfies Array<{ path: string; label: string; roles: Role[] }>;

export function permittedLandingPages(role: Role) {
  return landingPages.filter((page) => (page.roles as Role[]).includes(role)).map(({ path, label }) => ({ path, label }));
}

export function effectiveLandingPage(role: Role, saved: string | undefined): string {
  return saved && permittedLandingPages(role).some((page) => page.path === saved) ? saved : defaultLandingPages[role];
}

export function createRoleRedirectSchemas(zod: typeof import("zod").z) {
  return {
    settings: zod.array(zod.object({ role: zod.string(), label: zod.string(), landingPage: zod.string(), options: zod.array(zod.object({ path: zod.string(), label: zod.string() })) })),
    input: zod.object({ landingPage: zod.string().min(1).max(120) }).strict(),
    current: zod.object({ landingPage: zod.string() }),
  };
}
export const roleRedirectInput = createRoleRedirectSchemas(z).input;