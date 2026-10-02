import pg from 'pg';
import { config } from '../config/env.js';
import { logger } from '../config/logger.js';

const { Client } = pg;

export async function ensureDatabaseAndTables(): Promise<void> {
  const url = new URL(config.databaseUrl);
  const targetDb = url.pathname.replace('/', '') || 'FleetDB';

  // Connect to postgres maintenance DB first to check/create target database
  url.pathname = '/postgres';
  const adminClient = new Client({ connectionString: url.toString() });

  try {
    await adminClient.connect();
    const res = await adminClient.query(
      `SELECT 1 FROM pg_database WHERE datname = $1`,
      [targetDb]
    );

    if (res.rowCount === 0) {
      logger.info(`[Database] Database "${targetDb}" does not exist. Creating...`);
      await adminClient.query(`CREATE DATABASE "${targetDb}"`);
      logger.info(`[Database] Database "${targetDb}" created successfully.`);
    } else {
      logger.info(`[Database] Database "${targetDb}" exists.`);
    }
  } catch (err: unknown) {
    const error = err as Error;
    logger.warn({ error: error.message }, '[Database] Notice checking target database');
  } finally {
    await adminClient.end().catch(() => {});
  }

  // Connect to target database and create tables
  const dbClient = new Client({ connectionString: config.databaseUrl });
  try {
    await dbClient.connect();
    logger.info(`[Database] Initializing schema tables in "${targetDb}"...`);

    await dbClient.query(`
      CREATE EXTENSION IF NOT EXISTS "uuid-ossp";

      CREATE TABLE IF NOT EXISTS vehicles (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        plate_number TEXT NOT NULL UNIQUE,
        model TEXT NOT NULL DEFAULT 'Standard Fleet Unit',
        vehicle_type TEXT NOT NULL DEFAULT 'commuter_van',
        assigned_driver TEXT,
        current_km INTEGER NOT NULL DEFAULT 0,
        last_pms_km INTEGER NOT NULL DEFAULT 0,
        pms_interval_km INTEGER NOT NULL DEFAULT 5000,
        status TEXT NOT NULL DEFAULT 'active',
        created_at TIMESTAMP NOT NULL DEFAULT NOW(),
        updated_at TIMESTAMP NOT NULL DEFAULT NOW()
      );

      CREATE TABLE IF NOT EXISTS purchase_requisitions (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        pr_number TEXT NOT NULL UNIQUE,
        department TEXT NOT NULL,
        amount INTEGER NOT NULL DEFAULT 0,
        status TEXT NOT NULL DEFAULT 'draft',
        purpose TEXT NOT NULL,
        approved_by TEXT,
        approved_at TIMESTAMP,
        procurement_notes TEXT,
        created_at TIMESTAMP NOT NULL DEFAULT NOW()
      );

      CREATE TABLE IF NOT EXISTS pms_records (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        vehicle_id UUID NOT NULL REFERENCES vehicles(id) ON DELETE CASCADE,
        pms_km INTEGER NOT NULL,
        status TEXT NOT NULL DEFAULT 'scheduled',
        notes TEXT,
        completed_at TIMESTAMP,
        created_at TIMESTAMP NOT NULL DEFAULT NOW()
      );

      CREATE TABLE IF NOT EXISTS repair_work_orders (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        work_order_number TEXT NOT NULL UNIQUE,
        vehicle_id UUID NOT NULL REFERENCES vehicles(id) ON DELETE CASCADE,
        description TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'pending',
        linked_pr_id UUID REFERENCES purchase_requisitions(id),
        has_pms_compliance BOOLEAN NOT NULL DEFAULT FALSE,
        incident_report_filed BOOLEAN NOT NULL DEFAULT FALSE,
        procurement_fulfillment_status TEXT NOT NULL DEFAULT 'pending_pr_approval',
        created_at TIMESTAMP NOT NULL DEFAULT NOW()
      );

      CREATE TABLE IF NOT EXISTS incident_reports (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        vehicle_id UUID NOT NULL REFERENCES vehicles(id) ON DELETE CASCADE,
        repair_work_order_id UUID REFERENCES repair_work_orders(id) ON DELETE CASCADE,
        reported_by TEXT NOT NULL,
        incident_date TIMESTAMP NOT NULL,
        reason TEXT NOT NULL,
        damages_description TEXT NOT NULL,
        preventative_action TEXT,
        created_at TIMESTAMP NOT NULL DEFAULT NOW()
      );

      CREATE TABLE IF NOT EXISTS tsrf_requests (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        request_number TEXT NOT NULL UNIQUE,
        department TEXT NOT NULL,
        project_name TEXT NOT NULL,
        origin TEXT NOT NULL,
        destination TEXT NOT NULL,
        stops_json TEXT NOT NULL DEFAULT '[]',
        passengers_json TEXT NOT NULL DEFAULT '[]',
        cargo_json TEXT NOT NULL DEFAULT '[]',
        vehicle_type TEXT NOT NULL DEFAULT 'commuter_van',
        assigned_vehicle_id UUID REFERENCES vehicles(id),
        assigned_driver TEXT,
        departure_date TIMESTAMP NOT NULL,
        call_time TEXT NOT NULL,
        starting_km INTEGER,
        ending_km INTEGER,
        is_flagged_after_cutoff BOOLEAN NOT NULL DEFAULT FALSE,
        cutoff_reason TEXT,
        approval_status TEXT NOT NULL DEFAULT 'pending',
        linked_pr_id UUID REFERENCES purchase_requisitions(id),
        trip_status TEXT NOT NULL DEFAULT 'requested',
        created_at TIMESTAMP NOT NULL DEFAULT NOW()
      );

      CREATE TABLE IF NOT EXISTS roles (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        key TEXT NOT NULL UNIQUE,
        label TEXT NOT NULL,
        description TEXT NOT NULL DEFAULT '',
        color TEXT NOT NULL DEFAULT '#6366f1',
        is_system BOOLEAN NOT NULL DEFAULT FALSE,
        created_at TIMESTAMP NOT NULL DEFAULT NOW(),
        updated_at TIMESTAMP NOT NULL DEFAULT NOW()
      );

      CREATE TABLE IF NOT EXISTS permissions (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        key TEXT NOT NULL UNIQUE,
        label TEXT NOT NULL,
        description TEXT NOT NULL DEFAULT '',
        module_group TEXT NOT NULL DEFAULT 'general',
        created_at TIMESTAMP NOT NULL DEFAULT NOW()
      );

      CREATE TABLE IF NOT EXISTS role_permissions (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        role_id UUID NOT NULL REFERENCES roles(id) ON DELETE CASCADE,
        permission_key TEXT NOT NULL,
        created_at TIMESTAMP NOT NULL DEFAULT NOW()
      );

      CREATE TABLE IF NOT EXISTS users (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        name TEXT NOT NULL,
        email TEXT NOT NULL UNIQUE,
        role TEXT NOT NULL DEFAULT 'driver',
        department TEXT NOT NULL DEFAULT 'Fleet Operations',
        status TEXT NOT NULL DEFAULT 'active',
        last_active TIMESTAMP,
        created_at TIMESTAMP NOT NULL DEFAULT NOW(),
        updated_at TIMESTAMP NOT NULL DEFAULT NOW()
      );

      CREATE TABLE IF NOT EXISTS departments (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        code TEXT NOT NULL UNIQUE,
        name TEXT NOT NULL,
        head TEXT NOT NULL DEFAULT '',
        is_active BOOLEAN NOT NULL DEFAULT TRUE,
        created_at TIMESTAMP NOT NULL DEFAULT NOW()
      );

      CREATE TABLE IF NOT EXISTS vehicle_types_ref (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        code TEXT NOT NULL UNIQUE,
        label TEXT NOT NULL,
        category TEXT NOT NULL DEFAULT 'medium',
        pms_interval_km INTEGER NOT NULL DEFAULT 5000,
        is_active BOOLEAN NOT NULL DEFAULT TRUE,
        created_at TIMESTAMP NOT NULL DEFAULT NOW()
      );

      CREATE TABLE IF NOT EXISTS maintenance_categories (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        code TEXT NOT NULL UNIQUE,
        name TEXT NOT NULL,
        description TEXT NOT NULL DEFAULT '',
        is_active BOOLEAN NOT NULL DEFAULT TRUE,
        created_at TIMESTAMP NOT NULL DEFAULT NOW()
      );

      CREATE TABLE IF NOT EXISTS vendors (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        name TEXT NOT NULL UNIQUE,
        contact_person TEXT NOT NULL DEFAULT '',
        phone TEXT NOT NULL DEFAULT '',
        specialization TEXT NOT NULL DEFAULT '',
        is_active BOOLEAN NOT NULL DEFAULT TRUE,
        created_at TIMESTAMP NOT NULL DEFAULT NOW()
      );

      CREATE TABLE IF NOT EXISTS activity_logs (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        user_name TEXT NOT NULL,
        user_role TEXT NOT NULL,
        action TEXT NOT NULL,
        module TEXT NOT NULL,
        description TEXT NOT NULL,
        severity TEXT NOT NULL DEFAULT 'info',
        metadata_json TEXT NOT NULL DEFAULT '{}',
        created_at TIMESTAMP NOT NULL DEFAULT NOW()
      );

      CREATE TABLE IF NOT EXISTS lov_lists (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        code TEXT NOT NULL UNIQUE,
        name TEXT NOT NULL,
        description TEXT NOT NULL DEFAULT '',
        is_system BOOLEAN NOT NULL DEFAULT FALSE,
        supports_hierarchy BOOLEAN NOT NULL DEFAULT FALSE,
        status TEXT NOT NULL DEFAULT 'active',
        created_at TIMESTAMP NOT NULL DEFAULT NOW(),
        updated_at TIMESTAMP NOT NULL DEFAULT NOW()
      );

      CREATE TABLE IF NOT EXISTS lov_attributes (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        list_id UUID NOT NULL REFERENCES lov_lists(id) ON DELETE CASCADE,
        key TEXT NOT NULL,
        label TEXT NOT NULL,
        type TEXT NOT NULL DEFAULT 'text',
        required BOOLEAN NOT NULL DEFAULT FALSE,
        show_in_grid BOOLEAN NOT NULL DEFAULT TRUE,
        sort_order INTEGER NOT NULL DEFAULT 0,
        options_json TEXT NOT NULL DEFAULT '[]',
        created_at TIMESTAMP NOT NULL DEFAULT NOW(),
        UNIQUE (list_id, key)
      );

      CREATE TABLE IF NOT EXISTS lov_items (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        list_id UUID NOT NULL REFERENCES lov_lists(id) ON DELETE CASCADE,
        parent_id UUID,
        code TEXT NOT NULL,
        label TEXT NOT NULL,
        sort_order INTEGER NOT NULL DEFAULT 0,
        status TEXT NOT NULL DEFAULT 'active',
        effective_from TIMESTAMP,
        effective_to TIMESTAMP,
        attrs_json TEXT NOT NULL DEFAULT '{}',
        created_at TIMESTAMP NOT NULL DEFAULT NOW(),
        updated_at TIMESTAMP NOT NULL DEFAULT NOW(),
        UNIQUE (list_id, code)
      );

      CREATE TABLE IF NOT EXISTS form_definitions (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        key TEXT NOT NULL UNIQUE,
        name TEXT NOT NULL,
        created_at TIMESTAMP NOT NULL DEFAULT NOW(),
        updated_at TIMESTAMP NOT NULL DEFAULT NOW()
      );

      CREATE TABLE IF NOT EXISTS form_versions (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        form_definition_id UUID NOT NULL REFERENCES form_definitions(id) ON DELETE CASCADE,
        version INTEGER NOT NULL,
        schema_json TEXT NOT NULL,
        workflow_json TEXT NOT NULL DEFAULT '{}',
        status TEXT NOT NULL DEFAULT 'draft',
        published_by TEXT,
        published_at TIMESTAMP,
        created_at TIMESTAMP NOT NULL DEFAULT NOW(),
        updated_at TIMESTAMP NOT NULL DEFAULT NOW(),
        UNIQUE (form_definition_id, version)
      );

      CREATE SEQUENCE IF NOT EXISTS form_submission_number_seq START WITH 1;

      CREATE TABLE IF NOT EXISTS form_submissions (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        submission_number TEXT NOT NULL UNIQUE,
        form_version_id UUID NOT NULL REFERENCES form_versions(id),
        status TEXT NOT NULL DEFAULT 'in_review',
        stage TEXT NOT NULL,
        is_late BOOLEAN NOT NULL DEFAULT FALSE,
        cutoff_reason TEXT,
        data_json TEXT NOT NULL,
        label_snapshots_json TEXT NOT NULL DEFAULT '{}',
        created_by_id TEXT NOT NULL,
        created_by_name TEXT NOT NULL,
        created_by_role TEXT NOT NULL,
        created_at TIMESTAMP NOT NULL DEFAULT NOW(),
        updated_at TIMESTAMP NOT NULL DEFAULT NOW()
      );
      ALTER TABLE form_submissions ADD COLUMN IF NOT EXISTS is_late BOOLEAN NOT NULL DEFAULT FALSE;
      ALTER TABLE form_submissions ADD COLUMN IF NOT EXISTS cutoff_reason TEXT;

      CREATE TABLE IF NOT EXISTS form_submission_events (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        submission_id UUID NOT NULL REFERENCES form_submissions(id) ON DELETE CASCADE,
        from_stage TEXT,
        to_stage TEXT NOT NULL,
        action TEXT NOT NULL,
        actor_id TEXT NOT NULL,
        actor_name TEXT NOT NULL,
        actor_role TEXT NOT NULL,
        comment TEXT,
        created_at TIMESTAMP NOT NULL DEFAULT NOW()
      );

      CREATE INDEX IF NOT EXISTS form_submissions_version_created_idx
        ON form_submissions(form_version_id, created_at DESC);
      CREATE INDEX IF NOT EXISTS form_submission_events_submission_created_idx
        ON form_submission_events(submission_id, created_at DESC);

      -- Generic LOV seed is additive; legacy reference tables remain supported.
      INSERT INTO lov_lists (code, name, description, is_system) VALUES
        ('DEPARTMENTS', 'Departments', 'Organizational departments', TRUE),
        ('VEHICLE_TYPES', 'Vehicle Types', 'Fleet vehicle categories and types', TRUE),
        ('MAINTENANCE_CATEGORIES', 'Maintenance', 'Maintenance service categories', TRUE),
        ('VENDORS', 'Vendors', 'Service providers and repair shops', TRUE)
      ON CONFLICT (code) DO NOTHING;

      INSERT INTO lov_attributes (list_id, key, label, type, required, sort_order, options_json)
      SELECT id, 'head', 'Department Head', 'text', FALSE, 0, '[]' FROM lov_lists WHERE code = 'DEPARTMENTS'
      ON CONFLICT (list_id, key) DO NOTHING;
      INSERT INTO lov_attributes (list_id, key, label, type, required, sort_order, options_json)
      SELECT id, 'category', 'Category', 'select', TRUE, 0, '["light","medium","heavy","special"]' FROM lov_lists WHERE code = 'VEHICLE_TYPES'
      ON CONFLICT (list_id, key) DO NOTHING;
      INSERT INTO lov_attributes (list_id, key, label, type, required, sort_order, options_json)
      SELECT id, 'pms_interval_km', 'PMS Interval (km)', 'number', TRUE, 1, '[]' FROM lov_lists WHERE code = 'VEHICLE_TYPES'
      ON CONFLICT (list_id, key) DO NOTHING;
      INSERT INTO lov_attributes (list_id, key, label, type, required, sort_order, options_json)
      SELECT id, 'description', 'Description', 'text', FALSE, 0, '[]' FROM lov_lists WHERE code = 'MAINTENANCE_CATEGORIES'
      ON CONFLICT (list_id, key) DO NOTHING;
      INSERT INTO lov_attributes (list_id, key, label, type, required, sort_order, options_json)
      SELECT id, 'contact_person', 'Contact Person', 'text', FALSE, 0, '[]' FROM lov_lists WHERE code = 'VENDORS'
      ON CONFLICT (list_id, key) DO NOTHING;
      INSERT INTO lov_attributes (list_id, key, label, type, required, sort_order, options_json)
      SELECT id, 'phone', 'Phone', 'text', FALSE, 1, '[]' FROM lov_lists WHERE code = 'VENDORS'
      ON CONFLICT (list_id, key) DO NOTHING;
      INSERT INTO lov_attributes (list_id, key, label, type, required, sort_order, options_json)
      SELECT id, 'specialization', 'Specialization', 'text', FALSE, 2, '[]' FROM lov_lists WHERE code = 'VENDORS'
      ON CONFLICT (list_id, key) DO NOTHING;

      INSERT INTO lov_items (list_id, code, label, attrs_json)
      SELECT l.id, d.code, d.name, json_build_object('head', d.head)::text
      FROM departments d CROSS JOIN lov_lists l WHERE l.code = 'DEPARTMENTS'
      ON CONFLICT (list_id, code) DO NOTHING;
      INSERT INTO lov_items (list_id, code, label, attrs_json)
      SELECT l.id, v.code, v.label, json_build_object('category', v.category, 'pms_interval_km', v.pms_interval_km)::text
      FROM vehicle_types_ref v CROSS JOIN lov_lists l WHERE l.code = 'VEHICLE_TYPES'
      ON CONFLICT (list_id, code) DO NOTHING;
      INSERT INTO lov_items (list_id, code, label, attrs_json)
      SELECT l.id, c.code, c.name, json_build_object('description', c.description)::text
      FROM maintenance_categories c CROSS JOIN lov_lists l WHERE l.code = 'MAINTENANCE_CATEGORIES'
      ON CONFLICT (list_id, code) DO NOTHING;
      INSERT INTO lov_items (list_id, code, label, attrs_json)
      SELECT l.id, upper(regexp_replace(v.name, '[^A-Za-z0-9]+', '_', 'g')), v.name,
        json_build_object('contact_person', v.contact_person, 'phone', v.phone, 'specialization', v.specialization)::text
      FROM vendors v CROSS JOIN lov_lists l WHERE l.code = 'VENDORS'
      ON CONFLICT (list_id, code) DO NOTHING;

      -- Seed Default Roles
      INSERT INTO roles (key, label, description, color, is_system) VALUES
        ('superadmin', 'Super Administrator', 'Unrestricted administrative access to all enterprise modules', '#ef4444', TRUE),
        ('fleet_manager', 'Fleet Manager', 'Full control over fleet inventory, PMS scheduling and triage', '#3b82f6', TRUE),
        ('logistics_officer', 'Logistics Officer', 'Manages dispatch, TSRF trip approvals and manifests', '#10b981', TRUE),
        ('maintenance_supervisor', 'Maintenance Supervisor', 'Oversees repair work orders and incident gating compliance', '#f59e0b', TRUE),
        ('procurement_officer', 'Procurement Officer', 'Authorizes PR gating approvals and parts fulfillment', '#8b5cf6', TRUE),
        ('driver', 'Fleet Driver', 'Views assigned trip manifests and records vehicle odometers', '#64748b', TRUE)
      ON CONFLICT (key) DO NOTHING;

      -- Seed Reference Data: Departments
      INSERT INTO departments (code, name, head, is_active) VALUES
        ('FLEET', 'Fleet Operations', 'Marco Reyes', TRUE),
        ('LOG', 'Logistics & Dispatch', 'Roberto Santos', TRUE),
        ('FIN', 'Finance & Accounting', 'Sandra Cruz', TRUE),
        ('PROC', 'Procurement', 'Jose Lim', TRUE),
        ('HR', 'Human Resources', 'Ana Santos', TRUE),
        ('IT', 'Information Technology', 'Bryan Tan', TRUE),
        ('ADMIN', 'Administration', 'Maria Garcia', TRUE),
        ('OPS', 'Field Operations', 'Carlos Villanueva', TRUE)
      ON CONFLICT (code) DO NOTHING;

      -- Seed Reference Data: Vehicle Types
      INSERT INTO vehicle_types_ref (code, label, category, pms_interval_km, is_active) VALUES
        ('VAN', 'Commuter Van', 'light', 5000, TRUE),
        ('PICKUP', 'Pickup Truck', 'light', 5000, TRUE),
        ('ELF', 'Isuzu Elf (4-Wheeler)', 'medium', 5000, TRUE),
        ('TRUCK6W', '6-Wheeler Truck', 'heavy', 5000, TRUE),
        ('TRUCK10W', '10-Wheeler Truck', 'heavy', 5000, TRUE),
        ('TRAILER', 'Trailer / Articulated', 'heavy', 10000, TRUE),
        ('CRANE', 'Crane / Heavy Equipment', 'special', 250, TRUE),
        ('FORKLIFT', 'Forklift', 'special', 250, TRUE)
      ON CONFLICT (code) DO NOTHING;

      -- Seed Reference Data: Maintenance Categories
      INSERT INTO maintenance_categories (code, name, description, is_active) VALUES
        ('PMS', 'Preventive Maintenance Service', 'Scheduled 5,000 KM oil change, filter replacement', TRUE),
        ('BRAKE', 'Brake System Repair', 'Brake pad/disc replacement, hydraulic system', TRUE),
        ('ENGINE', 'Engine Overhaul', 'Major engine repair and component replacement', TRUE),
        ('TIRES', 'Tire Replacement', 'Tire replacement and rotation service', TRUE),
        ('ELECTRIC', 'Electrical System', 'Battery, alternator, wiring, lights repair', TRUE),
        ('BODY', 'Body & Collision Repair', 'Dent removal, painting, structural repair', TRUE),
        ('AIRCON', 'Air Conditioning', 'A/C compressor, refrigerant, blower repair', TRUE)
      ON CONFLICT (code) DO NOTHING;

      -- Seed Reference Data: Vendors
      INSERT INTO vendors (name, contact_person, phone, specialization, is_active) VALUES
        ('Pro Auto Service Center', 'Arturo Dela Vega', '09171234567', 'General PMS & Engine', TRUE),
        ('Speedy Brake & Tire Shop', 'Leo Maravilla', '09281234567', 'Brakes & Tires', TRUE),
        ('Hulma In-House Workshop', 'Fleet Team', 'Internal', 'All categories', TRUE)
      ON CONFLICT (name) DO NOTHING;

      -- Seed Default Users
      INSERT INTO users (name, email, role, department, status) VALUES
        ('Super Administrator', 'superadmin@hulma.com', 'superadmin', 'Administration', 'active'),
        ('Marco Reyes', 'fleet.manager@hulma.com', 'fleet_manager', 'Fleet Operations', 'active'),
        ('Roberto Santos', 'logistics@hulma.com', 'logistics_officer', 'Logistics & Dispatch', 'active'),
        ('Juan Dela Cruz', 'driver1@hulma.com', 'driver', 'Fleet Operations', 'active')
      ON CONFLICT (email) DO NOTHING;
    `);

    logger.info('[Database] All tables initialized successfully.');
  } catch (err: unknown) {
    const error = err as Error;
    logger.error({ error: error.message }, '[Database] Migration failed');
    throw error;
  } finally {
    await dbClient.end().catch(() => {});
  }
}

if (process.argv[1]?.includes('migrate')) {
  ensureDatabaseAndTables()
    .then(() => {
      logger.info('Migration complete.');
      process.exit(0);
    })
    .catch((err) => {
      logger.error(err);
      process.exit(1);
    });
}
