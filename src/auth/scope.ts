import type { AuthUser, Role } from "./abilities.js";

/**
 * Object-level scope for purchase requisitions. CASL decides *whether* a role
 * may act on PRs at all; this decides *which* PRs. Central functions operate
 * organisation-wide, department approvers only within their own department.
 */
export type PurchaseRequisitionScope =
  | { kind: "all" }
  | { kind: "department"; department: string }
  | { kind: "none" };

const ORGANISATION_WIDE_PR_ROLES: ReadonlySet<Role> = new Set<Role>([
  "admin",
  "finance",
  "procurement",
  "fleet_team",
]);

export function normaliseDepartment(value: string | null | undefined): string {
  return (value ?? "").trim().toLowerCase();
}

export function purchaseRequisitionScope(
  user: AuthUser | undefined,
): PurchaseRequisitionScope {
  if (!user) return { kind: "none" };
  if (ORGANISATION_WIDE_PR_ROLES.has(user.role)) return { kind: "all" };
  if (user.role === "approver") {
    const department = normaliseDepartment(user.department);
    return department ? { kind: "department", department } : { kind: "none" };
  }
  return { kind: "none" };
}

export function isPurchaseRequisitionInScope(
  scope: PurchaseRequisitionScope,
  prDepartment: string,
): boolean {
  if (scope.kind === "all") return true;
  if (scope.kind === "none") return false;
  return normaliseDepartment(prDepartment) === scope.department;
}
