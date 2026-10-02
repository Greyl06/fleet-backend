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

    default:
      can("read", "Vehicle");
      break;
  }

  return build();
}
