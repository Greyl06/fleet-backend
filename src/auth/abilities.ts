import {
  AbilityBuilder,
  createMongoAbility,
  MongoAbility,
} from "@casl/ability";

export type Role =
  | "fleet_team"
  | "procurement"
  | "finance"
  | "approver"
  | "department_requester"
  | "driver"
  | "admin";

export type Action =
  | "manage"
  | "create"
  | "read"
  | "update"
  | "delete"
  | "approve";

export type Subject =
  | "all"
  | "Vehicle"
  | "PMS"
  | "RepairWorkOrder"
  | "PurchaseRequisition"
  | "TSRFRequest"
  | "IncidentReport"
  | "FormDefinition"
  | "LovList";

export type AppAbility = MongoAbility<[Action, Subject]>;

export interface AuthUser {
  id: string;
  name: string;
  role: Role;
  department?: string;
}

export function mapInternalRole(role: string): Role | null {
  const roleMap: Record<string, Role> = {
    admin: "admin",
    system_admin: "admin",
    superadmin: "admin",
    fleet_team: "fleet_team",
    fleet_manager: "fleet_team",
    logistics_manager: "fleet_team",
    logistics_officer: "fleet_team",
    procurement: "procurement",
    procurement_officer: "procurement",
    finance: "finance",
    finance_manager: "finance",
    approver: "approver",
    department_requester: "department_requester",
    driver: "driver",
  };
  return roleMap[role] ?? null;
}

export function defineAbilityFor(user: AuthUser): AppAbility {
  const { can, cannot, build } = new AbilityBuilder<AppAbility>(
    createMongoAbility,
  );
  can("read", "LovList");

  switch (user.role) {
    case "admin":
      can("manage", "all");
      break;

    case "fleet_team":
      can("manage", "Vehicle");
      can("manage", "PMS");
      can("manage", "RepairWorkOrder");
      can("manage", "IncidentReport");
      can("read", "TSRFRequest");
      can("update", "TSRFRequest");
      can("read", "PurchaseRequisition");
      break;

    case "finance":
      can("manage", "PurchaseRequisition");
      can("approve", "PurchaseRequisition");
      can("approve", "TSRFRequest");
      can("read", "all");
      break;

    case "procurement":
      can("manage", "PurchaseRequisition");
      can("update", "RepairWorkOrder");
      can("read", "RepairWorkOrder");
      can("read", "Vehicle");
      can("read", "PurchaseRequisition");
      break;

    case "approver":
      can("read", "all");
      can("approve", "TSRFRequest");
      can("approve", "RepairWorkOrder");
      can("approve", "PurchaseRequisition");
      break;

    case "department_requester":
      can("create", "TSRFRequest");
      can("read", "TSRFRequest");
      can("read", "Vehicle");
      cannot("approve", "all");
      cannot("manage", "RepairWorkOrder");
      cannot("manage", "PurchaseRequisition");
      break;

    case "driver":
      can("read", "Vehicle");
      can("update", "Vehicle");
      can("read", "TSRFRequest");
      break;

    default:
      can("read", "Vehicle");
      break;
  }

  return build();
}
