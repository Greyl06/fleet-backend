import {
  pgTable,
  text,
  integer,
  timestamp,
  boolean,
  uuid,
} from "drizzle-orm/pg-core";

// ----------------------------------------------------
// Vehicles Registry (Module B)
// ----------------------------------------------------
export const vehicles = pgTable("vehicles", {
  id: uuid("id").defaultRandom().primaryKey(),
  plateNumber: text("plate_number").notNull().unique(),
  model: text("model").notNull().default("Standard Fleet Unit"),
  vehicleType: text("vehicle_type", {
    enum: [
      "commuter_van",
      "truck_4w",
      "truck_6w",
      "truck_10w",
      "container_unit",
      "3pl_provider",
    ],
  })
    .notNull()
    .default("commuter_van"),
  assignedDriver: text("assigned_driver"),
  currentKm: integer("current_km").notNull().default(0),
  lastPmsKm: integer("last_pms_km").notNull().default(0),
  pmsIntervalKm: integer("pms_interval_km").notNull().default(5000),
  status: text("status", {
    enum: ["active", "pms_due", "in_maintenance", "decommissioned"],
  })
    .notNull()
    .default("active"),
  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at").defaultNow().notNull(),
});

// ----------------------------------------------------
// Purchase Requisitions (Module C - PR Gatekeeper)
// ----------------------------------------------------
export const purchaseRequisitions = pgTable("purchase_requisitions", {
  id: uuid("id").defaultRandom().primaryKey(),
  prNumber: text("pr_number").notNull().unique(),
  department: text("department").notNull(),
  amount: integer("amount").notNull().default(0),
  status: text("status", {
    enum: ["draft", "pending", "approved", "rejected"],
  })
    .notNull()
    .default("draft"),
  purpose: text("purpose").notNull(),
  approvedBy: text("approved_by"),
  approvedAt: timestamp("approved_at"),
  procurementNotes: text("procurement_notes"),
  createdAt: timestamp("created_at").defaultNow().notNull(),
});

// ----------------------------------------------------
// PMS Records (Module B - 5,000 KM Tracking)
// ----------------------------------------------------
export const pmsRecords = pgTable("pms_records", {
  id: uuid("id").defaultRandom().primaryKey(),
  vehicleId: uuid("vehicle_id")
    .notNull()
    .references(() => vehicles.id),
  pmsKm: integer("pms_km").notNull(),
  status: text("status", {
    enum: ["scheduled", "in_progress", "completed", "skipped"],
  })
    .notNull()
    .default("scheduled"),
  notes: text("notes"),
  completedAt: timestamp("completed_at"),
  createdAt: timestamp("created_at").defaultNow().notNull(),
});

// ----------------------------------------------------
// Repair Work Orders (Module B & C)
// ----------------------------------------------------
export const repairWorkOrders = pgTable("repair_work_orders", {
  id: uuid("id").defaultRandom().primaryKey(),
  workOrderNumber: text("work_order_number").notNull().unique(),
  vehicleId: uuid("vehicle_id")
    .notNull()
    .references(() => vehicles.id),
  description: text("description").notNull(),
  status: text("status", {
    enum: ["pending", "approved", "in_progress", "completed", "rejected"],
  })
    .notNull()
    .default("pending"),
  linkedPrId: uuid("linked_pr_id").references(() => purchaseRequisitions.id),
  hasPmsCompliance: boolean("has_pms_compliance").notNull().default(false),
  incidentReportFiled: boolean("incident_report_filed")
    .notNull()
    .default(false),
  procurementFulfillmentStatus: text("procurement_fulfillment_status", {
    enum: [
      "pending_pr_approval",
      "pr_approved",
      "in_maintenance",
      "work_completed",
      "vehicle_operational",
    ],
  })
    .notNull()
    .default("pending_pr_approval"),
  createdAt: timestamp("created_at").defaultNow().notNull(),
});

// ----------------------------------------------------
// Incident Reports (Module B - Skipped PMS Mandatory Gate)
// ----------------------------------------------------
export const incidentReports = pgTable("incident_reports", {
  id: uuid("id").defaultRandom().primaryKey(),
  vehicleId: uuid("vehicle_id")
    .notNull()
    .references(() => vehicles.id),
  repairWorkOrderId: uuid("repair_work_order_id").references(
    () => repairWorkOrders.id,
  ),
  reportedBy: text("reported_by").notNull(),
  incidentDate: timestamp("incident_date").notNull(),
  reason: text("reason").notNull(),
  damagesDescription: text("damages_description").notNull(),
  preventativeAction: text("preventative_action"),
  createdAt: timestamp("created_at").defaultNow().notNull(),
});

// ----------------------------------------------------
// Transportation Service Requests - TSRF (Module A)
// ----------------------------------------------------
export const tsrfRequests = pgTable("tsrf_requests", {
  id: uuid("id").defaultRandom().primaryKey(),
  requestNumber: text("request_number").notNull().unique(),
  department: text("department").notNull(),
  projectName: text("project_name").notNull(),
  origin: text("origin").notNull(),
  destination: text("destination").notNull(),
  // Multi-stop routing & Google Maps addresses stored as JSON array string
  stopsJson: text("stops_json").notNull().default("[]"),
  // Driver & Passenger Manifests stored as JSON array string
  passengersJson: text("passengers_json").notNull().default("[]"),
  // Cargo & equipment control stored as JSON array string
  cargoJson: text("cargo_json").notNull().default("[]"),
  vehicleType: text("vehicle_type").notNull().default("commuter_van"),
  assignedVehicleId: uuid("assigned_vehicle_id").references(() => vehicles.id),
  assignedDriver: text("assigned_driver"),
  departureDate: timestamp("departure_date").notNull(),
  callTime: text("call_time").notNull(),
  startingKm: integer("starting_km"),
  endingKm: integer("ending_km"),
  isFlaggedAfterCutoff: boolean("is_flagged_after_cutoff")
    .notNull()
    .default(false),
  cutoffReason: text("cutoff_reason"),
  approvalStatus: text("approval_status", {
    enum: [
      "pending",
      "dept_approved",
      "logistics_approved",
      "finance_approved",
      "rejected",
    ],
  })
    .notNull()
    .default("pending"),
  linkedPrId: uuid("linked_pr_id").references(() => purchaseRequisitions.id),
  tripStatus: text("trip_status", {
    enum: [
      "requested",
      "approved",
      "dispatched",
      "in_transit",
      "completed",
      "cancelled",
    ],
  })
    .notNull()
    .default("requested"),
  createdAt: timestamp("created_at").defaultNow().notNull(),
});

// ----------------------------------------------------
// Roles & Permissions (Dynamic RBAC)
// ----------------------------------------------------
export const roles = pgTable("roles", {
  id: uuid("id").defaultRandom().primaryKey(),
  key: text("key").notNull().unique(),
  label: text("label").notNull(),
  description: text("description").notNull().default(""),
  color: text("color").notNull().default("#6366f1"),
  isSystem: boolean("is_system").notNull().default(false),
  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at").defaultNow().notNull(),
});

export const permissions = pgTable("permissions", {
  id: uuid("id").defaultRandom().primaryKey(),
  key: text("key").notNull().unique(),
  label: text("label").notNull(),
  description: text("description").notNull().default(""),
  moduleGroup: text("module_group").notNull().default("general"),
  createdAt: timestamp("created_at").defaultNow().notNull(),
});

export const rolePermissions = pgTable("role_permissions", {
  id: uuid("id").defaultRandom().primaryKey(),
  roleId: uuid("role_id")
    .notNull()
    .references(() => roles.id, { onDelete: "cascade" }),
  permissionKey: text("permission_key").notNull(),
  createdAt: timestamp("created_at").defaultNow().notNull(),
});

// ----------------------------------------------------
// Users Management
// ----------------------------------------------------
export const users = pgTable("users", {
  id: uuid("id").defaultRandom().primaryKey(),
  name: text("name").notNull(),
  email: text("email").notNull().unique(),
  role: text("role").notNull().default("driver"),
  department: text("department").notNull().default("Fleet Operations"),
  status: text("status", { enum: ["active", "inactive", "suspended"] })
    .notNull()
    .default("active"),
  lastActive: timestamp("last_active"),
  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at").defaultNow().notNull(),
});

// ----------------------------------------------------
// Maintenance Reference Data Tables (Dropdowns & Lookups)
// ----------------------------------------------------
export const departments = pgTable("departments", {
  id: uuid("id").defaultRandom().primaryKey(),
  code: text("code").notNull().unique(),
  name: text("name").notNull(),
  head: text("head").notNull().default(""),
  isActive: boolean("is_active").notNull().default(true),
  createdAt: timestamp("created_at").defaultNow().notNull(),
});

export const vehicleTypes = pgTable("vehicle_types_ref", {
  id: uuid("id").defaultRandom().primaryKey(),
  code: text("code").notNull().unique(),
  label: text("label").notNull(),
  category: text("category").notNull().default("medium"),
  pmsIntervalKm: integer("pms_interval_km").notNull().default(5000),
  isActive: boolean("is_active").notNull().default(true),
  createdAt: timestamp("created_at").defaultNow().notNull(),
});

export const maintenanceCategories = pgTable("maintenance_categories", {
  id: uuid("id").defaultRandom().primaryKey(),
  code: text("code").notNull().unique(),
  name: text("name").notNull(),
  description: text("description").notNull().default(""),
  isActive: boolean("is_active").notNull().default(true),
  createdAt: timestamp("created_at").defaultNow().notNull(),
});

export const vendors = pgTable("vendors", {
  id: uuid("id").defaultRandom().primaryKey(),
  name: text("name").notNull().unique(),
  contactPerson: text("contact_person").notNull().default(""),
  phone: text("phone").notNull().default(""),
  specialization: text("specialization").notNull().default(""),
  isActive: boolean("is_active").notNull().default(true),
  createdAt: timestamp("created_at").defaultNow().notNull(),
});

// ----------------------------------------------------
// Activity & Maintenance Audit Log
// ----------------------------------------------------
export const activityLogs = pgTable("activity_logs", {
  id: uuid("id").defaultRandom().primaryKey(),
  userName: text("user_name").notNull(),
  userRole: text("user_role").notNull(),
  action: text("action").notNull(),
  module: text("module").notNull(),
  description: text("description").notNull(),
  severity: text("severity", {
    enum: ["info", "warning", "critical", "success"],
  })
    .notNull()
    .default("info"),
  metadataJson: text("metadata_json").notNull().default("{}"),
  createdAt: timestamp("created_at").defaultNow().notNull(),
});

// ----------------------------------------------------
// LOV Engine — Generic List-of-Values
// ----------------------------------------------------
export const lovLists = pgTable("lov_lists", {
  id: uuid("id").defaultRandom().primaryKey(),
  code: text("code").notNull().unique(),
  name: text("name").notNull(),
  description: text("description").notNull().default(""),
  isSystem: boolean("is_system").notNull().default(false),
  supportsHierarchy: boolean("supports_hierarchy").notNull().default(false),
  status: text("status", { enum: ["active", "archived"] })
    .notNull()
    .default("active"),
  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at").defaultNow().notNull(),
});

export const lovAttributes = pgTable("lov_attributes", {
  id: uuid("id").defaultRandom().primaryKey(),
  listId: uuid("list_id")
    .notNull()
    .references(() => lovLists.id, { onDelete: "cascade" }),
  key: text("key").notNull(),
  label: text("label").notNull(),
  type: text("type", { enum: ["text", "number", "boolean", "select"] })
    .notNull()
    .default("text"),
  required: boolean("required").notNull().default(false),
  showInGrid: boolean("show_in_grid").notNull().default(true),
  sortOrder: integer("sort_order").notNull().default(0),
  optionsJson: text("options_json").notNull().default("[]"),
  createdAt: timestamp("created_at").defaultNow().notNull(),
});

export const lovItems = pgTable("lov_items", {
  id: uuid("id").defaultRandom().primaryKey(),
  listId: uuid("list_id")
    .notNull()
    .references(() => lovLists.id, { onDelete: "cascade" }),
  parentId: uuid("parent_id"),
  code: text("code").notNull(),
  label: text("label").notNull(),
  sortOrder: integer("sort_order").notNull().default(0),
  status: text("status", { enum: ["active", "inactive"] })
    .notNull()
    .default("active"),
  effectiveFrom: timestamp("effective_from"),
  effectiveTo: timestamp("effective_to"),
  attrsJson: text("attrs_json").notNull().default("{}"),
  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at").defaultNow().notNull(),
});

// ----------------------------------------------------
// Dynamic Form Definitions and Versions
// ----------------------------------------------------
export const formDefinitions = pgTable("form_definitions", {
  id: uuid("id").defaultRandom().primaryKey(),
  key: text("key").notNull().unique(),
  name: text("name").notNull(),
  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at").defaultNow().notNull(),
});

export const formVersions = pgTable("form_versions", {
  id: uuid("id").defaultRandom().primaryKey(),
  formDefinitionId: uuid("form_definition_id")
    .notNull()
    .references(() => formDefinitions.id, { onDelete: "cascade" }),
  version: integer("version").notNull(),
  schemaJson: text("schema_json").notNull(),
  workflowJson: text("workflow_json").notNull().default("{}"),
  status: text("status", { enum: ["draft", "published", "archived"] })
    .notNull()
    .default("draft"),
  publishedBy: text("published_by"),
  publishedAt: timestamp("published_at"),
  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at").defaultNow().notNull(),
});
