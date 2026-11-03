import argon2 from "argon2";
import { and, eq } from "drizzle-orm";
import { db, pool } from "../db/connection.js";
import { ensureDatabaseAndTables } from "../db/migrate.js";
import {
  authIdentities,
  formDefinitions,
  formVersions,
  localCredentials,
  permissions,
  roleLoginRedirects,
  rolePermissions,
  roles,
  users,
} from "../db/schema.js";
import { logger } from "../config/logger.js";

// ─── 1. Role Definitions ───────────────────────────────────────────────────────
const SEED_ROLES = [
  {
    key: "admin",
    label: "System Administrator",
    description: "Full access to all modules, system configurations, and user management.",
    color: "#6366f1",
    isSystem: true,
    landingPage: "/dashboard",
  },
  {
    key: "superadmin",
    label: "Super Administrator",
    description: "Unrestricted administrative access to all enterprise modules.",
    color: "#ef4444",
    isSystem: true,
    landingPage: "/dashboard",
  },
  {
    key: "fleet_manager",
    label: "Fleet Manager",
    description: "Full control over vehicle inventory, PMS scheduling, work orders, and triage.",
    color: "#3b82f6",
    isSystem: true,
    landingPage: "/fleet",
  },
  {
    key: "logistics_officer",
    label: "Logistics Officer",
    description: "Manages trip dispatches, driver assignments, and TSRF logistics.",
    color: "#10b981",
    isSystem: true,
    landingPage: "/tsrf",
  },
  {
    key: "finance_manager",
    label: "Finance Manager",
    description: "Reviews financial impacts, vehicle TCO, and approves purchase requisitions.",
    color: "#10b981",
    isSystem: true,
    landingPage: "/procurement",
  },
  {
    key: "procurement_officer",
    label: "Procurement Officer",
    description: "Authorizes PR gating, parts fulfillment, and vendor procurement.",
    color: "#8b5cf6",
    isSystem: true,
    landingPage: "/procurement",
  },
  {
    key: "department_requester",
    label: "Department Requester",
    description: "Submits and tracks transportation service requests (TSRF).",
    color: "#f97316",
    isSystem: true,
    landingPage: "/tsrf",
  },
  {
    key: "approver",
    label: "Department Approver",
    description: "Reviews and endorses assigned department trip requests.",
    color: "#14b8a6",
    isSystem: true,
    landingPage: "/tsrf",
  },
  {
    key: "driver",
    label: "Fleet Driver",
    description: "Accesses driver quick-log, manifests, and records vehicle odometer readings.",
    color: "#64748b",
    isSystem: true,
    landingPage: "/driver",
  },
  {
    key: "auditor",
    label: "Organization Auditor",
    description: "Read-only access to organization audit logs, history, and submission reports.",
    color: "#0d9488",
    isSystem: true,
    landingPage: "/reports",
  },
];

// ─── 2. Permissions Master Catalog ─────────────────────────────────────────────
const SEED_PERMISSIONS = [
  // Page Access
  { key: "view:dashboard", label: "View Dashboard", group: "Page Access" },
  { key: "view:fleet", label: "View Fleet Module", group: "Page Access" },
  { key: "view:tsrf", label: "View TSRF Module", group: "Page Access" },
  { key: "view:procurement", label: "View Procurement Module", group: "Page Access" },
  { key: "view:maintenance_ref", label: "View Reference Data", group: "Page Access" },
  { key: "view:users", label: "View User Management", group: "Page Access" },
  { key: "view:roles", label: "View Roles Management", group: "Page Access" },
  { key: "view:reports", label: "View Reports", group: "Page Access" },
  { key: "view:audit", label: "View Audit History", group: "Page Access" },

  // TSRF & Logistics
  { key: "create:tsrf", label: "Create TSRF", group: "TSRF & Logistics" },
  { key: "approve:tsrf", label: "Approve TSRF", group: "TSRF & Logistics" },

  // Fleet & PMS
  { key: "create:vehicle", label: "Add Vehicles", group: "Fleet & PMS" },
  { key: "update:vehicle_km", label: "Update Odometer", group: "Fleet & PMS" },
  { key: "schedule:pms", label: "Schedule PMS", group: "Fleet & PMS" },

  // Maintenance & Work Orders
  { key: "create:work_order", label: "Create Work Orders", group: "Maintenance" },
  { key: "approve:work_order", label: "Approve Work Orders", group: "Maintenance" },

  // Procurement
  { key: "create:pr", label: "Create PR", group: "Procurement" },
  { key: "approve:pr", label: "Approve PR", group: "Procurement" },

  // Administration
  { key: "manage:users", label: "Manage Users", group: "Administration" },
  { key: "manage:roles", label: "Manage Roles", group: "Administration" },
  { key: "manage:reference_data", label: "Manage Reference Data", group: "Administration" },
];

// ─── 3. Seed User Accounts ─────────────────────────────────────────────────────
const SEED_USERS = [
  {
    name: "System Administrator",
    email: "admin@hulma.com",
    password: "admin123",
    role: "admin",
    department: "Administration",
  },
  {
    name: "Super Administrator",
    email: "superadmin@hulma.com",
    password: "admin123",
    role: "superadmin",
    department: "Administration",
  },
  {
    name: "Marco Reyes",
    email: "marco.reyes@hulma.com",
    password: "fleet123",
    role: "fleet_manager",
    department: "Fleet Operations",
  },
  {
    name: "Fleet Manager Alias",
    email: "fleet.manager@hulma.com",
    password: "fleet123",
    role: "fleet_manager",
    department: "Fleet Operations",
  },
  {
    name: "Roberto Santos",
    email: "roberto.santos@hulma.com",
    password: "logistics123",
    role: "logistics_officer",
    department: "Logistics & Dispatch",
  },
  {
    name: "Logistics Officer Alias",
    email: "logistics@hulma.com",
    password: "logistics123",
    role: "logistics_officer",
    department: "Logistics & Dispatch",
  },
  {
    name: "Sandra Cruz",
    email: "sandra.cruz@hulma.com",
    password: "finance123",
    role: "finance_manager",
    department: "Finance & Accounting",
  },
  {
    name: "Jose Lim",
    email: "jose.lim@hulma.com",
    password: "procure123",
    role: "procurement_officer",
    department: "Procurement",
  },
  {
    name: "Ana Santos",
    email: "ana.santos@hulma.com",
    password: "request123",
    role: "department_requester",
    department: "Human Resources",
  },
  {
    name: "Carlos Villanueva",
    email: "carlos.approver@hulma.com",
    password: "approve123",
    role: "approver",
    department: "Field Operations",
  },
  {
    name: "Department Approver",
    email: "approver@hulma.com",
    password: "approve123",
    role: "approver",
    department: "Administration",
  },
  {
    name: "Juan Dela Cruz",
    email: "driver1@hulma.com",
    password: "driver123",
    role: "driver",
    department: "Fleet Operations",
  },
  {
    name: "Maria Auditor",
    email: "auditor@hulma.com",
    password: "audit123",
    role: "auditor",
    department: "Administration",
  },
];

async function seed() {
  logger.info("[Seed] Initializing database schema...");
  await ensureDatabaseAndTables();

  // 1. Seed Roles & Landing Pages
  logger.info("[Seed] Seeding Roles and Post-Login Landing Pages...");
  for (const r of SEED_ROLES) {
    const [existingRole] = await db.select().from(roles).where(eq(roles.key, r.key));
    let roleId: string;
    if (existingRole) {
      roleId = existingRole.id;
      await db
        .update(roles)
        .set({
          label: r.label,
          description: r.description,
          color: r.color,
          isSystem: r.isSystem,
          updatedAt: new Date(),
        })
        .where(eq(roles.id, existingRole.id));
    } else {
      const [newRole] = await db
        .insert(roles)
        .values({
          key: r.key,
          label: r.label,
          description: r.description,
          color: r.color,
          isSystem: r.isSystem,
        })
        .returning();
      roleId = newRole.id;
    }

    // Upsert landing page redirect
    await db
      .insert(roleLoginRedirects)
      .values({
        roleKey: r.key,
        landingPage: r.landingPage,
        updatedById: "system-seed",
        updatedAt: new Date(),
      })
      .onConflictDoUpdate({
        target: roleLoginRedirects.roleKey,
        set: {
          landingPage: r.landingPage,
          updatedById: "system-seed",
          updatedAt: new Date(),
        },
      });
  }

  // 2. Seed Permissions
  logger.info("[Seed] Seeding System Permissions...");
  for (const p of SEED_PERMISSIONS) {
    await db
      .insert(permissions)
      .values({
        key: p.key,
        label: p.label,
        moduleGroup: p.group,
      })
      .onConflictDoUpdate({
        target: permissions.key,
        set: {
          label: p.label,
          moduleGroup: p.group,
        },
      });
  }

  // 3. Grant Permissions to Admin Roles
  logger.info("[Seed] Assigning Role Permissions...");
  const allRoles = await db.select().from(roles);
  for (const roleRow of allRoles) {
    // Clear and assign default permissions based on role
    await db.delete(rolePermissions).where(eq(rolePermissions.roleId, roleRow.id));

    let permsToGrant: string[] = [];
    if (roleRow.key === "admin" || roleRow.key === "superadmin") {
      permsToGrant = SEED_PERMISSIONS.map((p) => p.key);
    } else if (roleRow.key === "fleet_manager") {
      permsToGrant = [
        "view:dashboard",
        "view:fleet",
        "view:tsrf",
        "view:procurement",
        "view:reports",
        "create:vehicle",
        "update:vehicle_km",
        "schedule:pms",
        "create:work_order",
        "approve:work_order",
        "create:pr",
      ];
    } else if (roleRow.key === "logistics_officer") {
      permsToGrant = [
        "view:dashboard",
        "view:tsrf",
        "view:fleet",
        "create:tsrf",
        "approve:tsrf",
        "update:vehicle_km",
      ];
    } else if (roleRow.key === "finance_manager") {
      permsToGrant = ["view:dashboard", "view:procurement", "view:reports", "approve:pr"];
    } else if (roleRow.key === "procurement_officer") {
      permsToGrant = ["view:dashboard", "view:procurement", "create:pr", "approve:pr"];
    } else if (roleRow.key === "department_requester") {
      permsToGrant = ["view:dashboard", "view:tsrf", "create:tsrf"];
    } else if (roleRow.key === "approver") {
      permsToGrant = ["view:dashboard", "view:tsrf", "approve:tsrf"];
    } else if (roleRow.key === "driver") {
      permsToGrant = ["view:fleet", "update:vehicle_km"];
    } else if (roleRow.key === "auditor") {
      permsToGrant = ["view:reports", "view:audit"];
    }

    for (const permKey of permsToGrant) {
      await db.insert(rolePermissions).values({
        roleId: roleRow.id,
        permissionKey: permKey,
      });
    }
  }

  // 4. Seed User Accounts, Passwords, and Auth Identities
  logger.info("[Seed] Seeding User Accounts and Credentials...");
  for (const u of SEED_USERS) {
    const normalizedEmail = u.email.trim().toLowerCase();
    const [existingUser] = await db
      .select()
      .from(users)
      .where(eq(users.email, normalizedEmail));

    let userId: string;
    if (existingUser) {
      userId = existingUser.id;
      await db
        .update(users)
        .set({
          name: u.name,
          role: u.role,
          department: u.department,
          status: "active",
        })
        .where(eq(users.id, userId));
    } else {
      const [newUser] = await db
        .insert(users)
        .values({
          name: u.name,
          email: normalizedEmail,
          role: u.role,
          department: u.department,
          status: "active",
        })
        .returning();
      userId = newUser.id;
    }

    // Hash password with Argon2id
    const passwordHash = await argon2.hash(u.password, { type: argon2.argon2id });

    // Upsert local_credentials
    const [existingCred] = await db
      .select()
      .from(localCredentials)
      .where(eq(localCredentials.userId, userId));

    if (existingCred) {
      await db
        .update(localCredentials)
        .set({ passwordHash, resetRequired: false })
        .where(eq(localCredentials.userId, userId));
    } else {
      await db.insert(localCredentials).values({
        userId,
        passwordHash,
        resetRequired: false,
      });
    }

    // Upsert auth_identities
    const [existingIdentity] = await db
      .select()
      .from(authIdentities)
      .where(
        and(
          eq(authIdentities.provider, "local"),
          eq(authIdentities.subject, normalizedEmail),
        ),
      );

    if (!existingIdentity) {
      await db.insert(authIdentities).values({
        provider: "local",
        issuer: "",
        subject: normalizedEmail,
        userId,
      });
    }
  }

  // 5. Seed Published TSRF Form Definition & Workflow
  logger.info("[Seed] Seeding Published TSRF Form Definition & Workflow...");
  const [existingFormDef] = await db
    .select()
    .from(formDefinitions)
    .where(eq(formDefinitions.key, "tsrf"));

  let formDefId: string;
  if (existingFormDef) {
    formDefId = existingFormDef.id;
    await db
      .update(formDefinitions)
      .set({
        name: "Transportation Service Request Form",
        updatedAt: new Date(),
      })
      .where(eq(formDefinitions.id, formDefId));
  } else {
    const [newDef] = await db
      .insert(formDefinitions)
      .values({
        key: "tsrf",
        name: "Transportation Service Request Form",
      })
      .returning();
    formDefId = newDef.id;
  }

  const tsrfWorkflow = {
    initialStage: "submitted",
    stages: [
      { id: "draft", label: "Draft", statusCategory: "draft" },
      { id: "submitted", label: "Submitted", statusCategory: "in_review" },
      { id: "endorsement", label: "Endorsement", statusCategory: "in_review" },
      { id: "finance_verification", label: "Finance Verification", statusCategory: "in_review" },
      { id: "approval", label: "Approval", statusCategory: "approved" },
      { id: "dispatch_assignment", label: "Dispatch Assignment", statusCategory: "approved" },
      { id: "confirmed", label: "Confirmed", statusCategory: "approved" },
      { id: "in_progress", label: "In Progress", statusCategory: "in_progress", fieldPermissions: { endingKm: { fleet_team: "edit", admin: "edit" } } },
      { id: "completed", label: "Completed", statusCategory: "completed" },
      { id: "returned", label: "Returned", statusCategory: "returned" },
      { id: "rejected", label: "Rejected", statusCategory: "rejected" },
      { id: "cancelled", label: "Cancelled", statusCategory: "cancelled" },
    ],
    transitions: [
      { from: "draft", to: "submitted", roles: ["department_requester", "admin"] },
      { from: "submitted", to: "endorsement", roles: ["approver", "admin"] },
      { from: "submitted", to: "returned", roles: ["approver", "admin"], reasonRequired: true },
      { from: "returned", to: "submitted", roles: ["department_requester", "admin"], action: "resubmitted" },
      { from: "submitted", to: "rejected", roles: ["approver", "admin"], reasonRequired: true },
      { from: "endorsement", to: "finance_verification", roles: ["finance", "admin"] },
      { from: "endorsement", to: "approval", roles: ["approver", "admin"] },
      { from: "endorsement", to: "returned", roles: ["approver", "admin"], reasonRequired: true },
      { from: "finance_verification", to: "approval", roles: ["finance", "approver", "admin"] },
      { from: "approval", to: "dispatch_assignment", roles: ["approver", "admin"] },
      { from: "dispatch_assignment", to: "confirmed", roles: ["fleet_team", "admin"] },
      { from: "confirmed", to: "in_progress", roles: ["fleet_team", "admin"] },
      { from: "in_progress", to: "completed", roles: ["fleet_team", "admin"] },
      { from: "draft", to: "cancelled", roles: ["department_requester", "admin"], reasonRequired: true },
      { from: "submitted", to: "cancelled", roles: ["department_requester", "admin"], reasonRequired: true, action: "cancelled" },
      { from: "returned", to: "cancelled", roles: ["department_requester", "admin"], reasonRequired: true, action: "cancelled" },
    ],
    cutoff: {
      time: "16:00",
      timezone: "Asia/Manila",
      latePolicy: "flag_and_exception_approval",
      exceptionStage: "endorsement",
    },
  };

  const tsrfSchema = {
    key: "tsrf",
    name: "Transportation Service Request Form",
    version: 1,
    status: "published",
    sections: [
      {
        id: "intake-notice",
        title: "TSRF Intake",
        fields: [
          {
            id: "cutoff-notice",
            key: "cutoff_notice",
            type: "notice",
            label: "Cut-off Notice",
            section: "intake-notice",
            content: "Regular TSRF intake is available until the daily 4:00 PM cut-off.",
          },
        ],
      },
      {
        id: "trip-details",
        title: "1. Transportation Service Request",
        description: "Specify the project, schedule, and vehicle allocation requirements.",
        fields: [
          {
            id: "entity",
            key: "entity",
            type: "lookup",
            label: "Entity",
            section: "trip-details",
            required: true,
            dataSource: { kind: "lov", listCode: "ENTITIES" },
            meta: { reportable: true, pii: false },
          },
          {
            id: "project-name",
            key: "projectName",
            type: "text",
            label: "Project Name",
            section: "trip-details",
            required: true,
            defaultValue: "Asset Retrieval and KE Biometric Project",
          },
          {
            id: "department",
            key: "department",
            type: "lookup",
            label: "Requesting Department",
            section: "trip-details",
            required: true,
            dataSource: { kind: "lov", listCode: "DEPARTMENTS" },
            meta: { reportable: true, pii: false },
            options: [
              { value: "IT", label: "Information Technology" },
              { value: "LOG", label: "Logistics & Dispatch" },
            ],
          },
          {
            id: "departure-date",
            key: "departureDate",
            type: "date",
            label: "Departure Date",
            section: "trip-details",
            required: true,
            meta: { reportable: true, pii: false },
          },
          {
            id: "call-time",
            key: "callTime",
            type: "time",
            label: "Expected Call Time",
            section: "trip-details",
            required: true,
          },
          {
            id: "vehicle-type",
            key: "vehicleType",
            type: "lookup",
            label: "Vehicle Type / Allocation",
            section: "trip-details",
            required: true,
            dataSource: { kind: "lov", listCode: "VEHICLE_TYPES" },
            meta: { reportable: true, pii: false },
            width: "full",
            options: [
              { value: "VAN", label: "Commuter Van" },
              { value: "TRUCK6W", label: "6-Wheeler Truck" },
              { value: "TRUCK10W", label: "10-Wheeler Truck" },
            ],
          },
          {
            id: "allocation-type",
            key: "allocationType",
            type: "select",
            label: "Allocation Type",
            section: "trip-details",
            required: true,
            defaultValue: "fleet_asset",
            options: [
              { value: "fleet_asset", label: "Fleet Asset" },
              { value: "third_party_trucker", label: "3rd Party Trucker" },
            ],
          },
          {
            id: "assigned-vehicle",
            key: "assignedVehicleId",
            type: "entity_lookup",
            label: "Fleet Vehicle",
            section: "trip-details",
            required: false,
            defaultValue: "",
            dataSource: {
              kind: "entity",
              entity: "vehicles",
              valueField: "id",
              labelField: "plateNumber",
            },
            rules: [
              {
                when: { field: "allocationType", operator: "eq", value: "third_party_trucker" },
                show: false,
              },
            ],
          },
          {
            id: "ending-km",
            key: "endingKm",
            type: "number",
            label: "Ending Odometer (km)",
            section: "trip-details",
            required: false,
            meta: { reportable: true, pii: false },
            rules: [
              {
                when: { field: "allocationType", operator: "neq", value: "fleet_asset" },
                show: false,
              },
            ],
          },
          {
            id: "trucker-name",
            key: "truckerName",
            type: "text",
            label: "Third-party Trucker",
            section: "trip-details",
            required: true,
            defaultValue: "",
            rules: [
              {
                when: { field: "allocationType", operator: "eq", value: "fleet_asset" },
                show: false,
              },
            ],
          },
        ],
      },
      {
        id: "route",
        title: "2. Multi-Stop Route & Location Management",
        fields: [
          {
            id: "origin",
            key: "origin",
            type: "text",
            label: "Primary Origin",
            section: "route",
            required: true,
          },
          {
            id: "destination",
            key: "destination",
            type: "text",
            label: "Primary Destination",
            section: "route",
            required: true,
          },
          {
            id: "stops",
            key: "stops",
            type: "repeater",
            label: "Waypoints & Stops",
            section: "route",
            minRows: 1,
            maxRows: 10,
            defaultValue: [
              {
                stopOrder: 1,
                locationName: "MMG Warehouse",
                address: "Building 4, MMG Logistics Complex",
                waitingTimeMinutes: 15,
                notes: "Initial cargo loading",
              },
              {
                stopOrder: 2,
                locationName: "Kingston Excell Facility",
                address: "Lot 12 Kingston Industrial Park",
                waitingTimeMinutes: 45,
                notes: "Unloading biometric terminals",
              },
            ],
            rowFields: [
              {
                id: "stop-location",
                key: "locationName",
                type: "text",
                label: "Stop Name",
                section: "stop",
                required: true,
              },
              {
                id: "stop-address",
                key: "address",
                type: "text",
                label: "Address",
                section: "stop",
                required: true,
              },
              {
                id: "stop-wait",
                key: "waitingTimeMinutes",
                type: "number",
                label: "Waiting Time (minutes)",
                section: "stop",
              },
              { id: "stop-notes", key: "notes", type: "textarea", label: "Notes", section: "stop" },
            ],
          },
        ],
      },
      {
        id: "passengers",
        title: "3. Passenger Manifest",
        description: "Record each passenger travelling on the request.",
        fields: [
          {
            id: "passengers",
            key: "passengers",
            type: "repeater",
            label: "Passengers",
            section: "passengers",
            required: true,
            minRows: 1,
            maxRows: 10,
            defaultValue: [
              { name: "Juan Dela Cruz", department: "IT Support", role: "Lead Technician" },
              { name: "Maria Santos", department: "Asset Management", role: "Auditor" },
            ],
            rowFields: [
              {
                id: "passenger-name",
                key: "name",
                type: "text",
                label: "Name",
                section: "passenger",
                required: true,
                meta: { reportable: false, pii: true },
              },
              {
                id: "passenger-department",
                key: "department",
                type: "text",
                label: "Department",
                section: "passenger",
                required: true,
              },
              {
                id: "passenger-role",
                key: "role",
                type: "text",
                label: "Role",
                section: "passenger",
              },
            ],
          },
        ],
      },
      {
        id: "cargo",
        title: "4. Cargo & Equipment Control",
        fields: [
          {
            id: "cargo",
            key: "cargo",
            type: "repeater",
            label: "Cargo Items",
            section: "cargo",
            maxRows: 10,
            defaultValue: [
              {
                description: "KE Biometric Scanners (Pack of 10)",
                quantity: 2,
                weightKg: 15,
                isFragile: true,
              },
            ],
            rowFields: [
              {
                id: "cargo-description",
                key: "description",
                type: "text",
                label: "Description",
                section: "cargo-item",
                required: true,
              },
              {
                id: "cargo-quantity",
                key: "quantity",
                type: "number",
                label: "Quantity",
                section: "cargo-item",
                required: true,
              },
              {
                id: "cargo-weight",
                key: "weightKg",
                type: "number",
                label: "Weight (kg)",
                section: "cargo-item",
              },
              {
                id: "cargo-fragile",
                key: "isFragile",
                type: "checkbox",
                label: "Fragile",
                section: "cargo-item",
              },
            ],
          },
        ],
      },
    ],
  };

  const [existingVersion] = await db
    .select()
    .from(formVersions)
    .where(
      and(
        eq(formVersions.formDefinitionId, formDefId),
        eq(formVersions.version, 1),
      ),
    );

  if (existingVersion) {
    await db
      .update(formVersions)
      .set({
        schemaJson: JSON.stringify(tsrfSchema),
        workflowJson: JSON.stringify(tsrfWorkflow),
        status: "published",
        versionName: "v1.0 (Production)",
        publishedBy: "System Administrator",
        publishedAt: new Date(),
        updatedAt: new Date(),
      })
      .where(eq(formVersions.id, existingVersion.id));
  } else {
    await db.insert(formVersions).values({
      formDefinitionId: formDefId,
      version: 1,
      schemaJson: JSON.stringify(tsrfSchema),
      workflowJson: JSON.stringify(tsrfWorkflow),
      status: "published",
      versionName: "v1.0 (Production)",
      publishedBy: "System Administrator",
      publishedAt: new Date(),
    });
  }

  logger.info("=================================================================");
  logger.info("  FLEET DEMO ACCOUNTS SEEDED SUCCESSFULLY");
  logger.info("=================================================================");
  logger.info("  Role                   Email                    Password");
  logger.info("  -------------------------------------------------------------");
  for (const u of SEED_USERS) {
    const rPad = u.role.padEnd(22, " ");
    const ePad = u.email.padEnd(24, " ");
    logger.info(`  ${rPad} ${ePad} ${u.password}`);
  }
  logger.info("=================================================================");
}

seed()
  .then(() => {
    logger.info("[Seed] Done!");
    process.exit(0);
  })
  .catch((err) => {
    logger.error(err, "[Seed] Fatal error seeding data");
    process.exit(1);
  })
  .finally(async () => {
    await pool.end();
  });
