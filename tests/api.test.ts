import { describe, it, expect, beforeAll, afterAll } from "vitest";
import request from "supertest";
import { app } from "../src/app.js";
import { ensureDatabaseAndTables } from "../src/db/migrate.js";
import { pool } from "../src/db/connection.js";
import { randomUUID } from "node:crypto";

describe("Fleet Backend API Integration Tests", () => {
  beforeAll(async () => {
    await ensureDatabaseAndTables();
  });

  afterAll(async () => {
    await pool.end();
  });

  describe("GET /api/health", () => {
    it("should return health status", async () => {
      const res = await request(app).get("/api/health");
      expect(res.status).toBe(200);
      expect(res.body.status).toBe("ok");
    });
  });

  describe("Generic LOV Engine", () => {
    it("should expose seeded lists and soft-deactivate items", async () => {
      const listsRes = await request(app)
        .get("/api/lov/lists")
        .set("x-user-role", "department_requester");
      expect(listsRes.status).toBe(200);
      expect(
        listsRes.body.some(
          (list: { code: string }) => list.code === "DEPARTMENTS",
        ),
      ).toBe(true);

      const deniedWrite = await request(app)
        .post("/api/lov/lists/DEPARTMENTS/items")
        .set("x-user-role", "department_requester")
        .send({ code: "DENIED", label: "Denied" });
      expect(deniedWrite.status).toBe(403);

      const attributeKey = `test_attr_${Date.now()}`;
      const attributeRes = await request(app)
        .post("/api/lov/lists/DEPARTMENTS/attributes")
        .send({ key: attributeKey, label: "Test Attribute", type: "text" });
      expect(attributeRes.status).toBe(201);
      expect(attributeRes.body.key).toBe(attributeKey);

      const attributesRes = await request(app).get(
        "/api/lov/lists/DEPARTMENTS/attributes",
      );
      expect(
        attributesRes.body.some(
          (attribute: { key: string }) => attribute.key === attributeKey,
        ),
      ).toBe(true);
      const deleteAttributeRes = await request(app).delete(
        `/api/lov/attributes/${attributeRes.body.id}`,
      );
      expect(deleteAttributeRes.status).toBe(200);

      const itemRes = await request(app)
        .post("/api/lov/lists/DEPARTMENTS/items")
        .send({
          code: `TEST_${Date.now()}`,
          label: "Test Department",
          attrs: { head: "Test Head" },
        });
      expect(itemRes.status).toBe(201);
      expect(itemRes.body.attrs.head).toBe("Test Head");

      const deactivateRes = await request(app).delete(
        `/api/lov/items/${itemRes.body.id}`,
      );
      expect(deactivateRes.status).toBe(200);
      expect(deactivateRes.body.status).toBe("inactive");
    });
  });

  describe("Versioned Form Definitions", () => {
    it("should create a draft form and publish its version", async () => {
      const key = `test-form-${Date.now()}`;
      const plateNumber = `FORM-LOOKUP-${Date.now()}`;
      const vehicleRes = await request(app).post("/api/vehicles").send({
        plateNumber,
        model: "Test Commuter Van",
        vehicleType: "commuter_van",
        currentKm: 100,
        lastPmsKm: 0,
        pmsIntervalKm: 5000,
      });
      expect(vehicleRes.status).toBe(201);
      const vehicleLookupRes = await request(app)
        .get('/api/vehicles')
        .set('x-user-role', 'department_requester');
      expect(vehicleLookupRes.status).toBe(200);
      expect(vehicleLookupRes.body.some((vehicle: { id: string }) => vehicle.id === vehicleRes.body.id)).toBe(true);
      const schema = {
        key,
        name: "Test Form",
        version: 1,
        status: "draft",
        sections: [
          {
            id: "request",
            title: "Request",
            fields: [
              {
                id: "department",
                key: "department",
                type: "lookup",
                label: "Department",
                section: "request",
                required: true,
                dataSource: { kind: "lov", listCode: "DEPARTMENTS" },
                meta: { reportable: true, pii: false },
              },
              {
                id: "project",
                key: "project",
                type: "text",
                label: "Project",
                section: "request",
                required: true,
                meta: { reportable: true, pii: true },
              },
              {
                id: "dispatch-notes",
                key: "dispatch_notes",
                type: "text",
                label: "Dispatch Notes",
                section: "request",
              },
              {
                id: "vehicle",
                key: "vehicleId",
                type: "entity_lookup",
                label: "Fleet Vehicle",
                section: "request",
                required: true,
                dataSource: { kind: "entity", entity: "vehicles", valueField: "id", labelField: "plateNumber" },
                meta: { reportable: true, pii: false },
              },
            ],
          },
        ],
      };
      const workflow = {
        initialStage: "submitted",
        stages: [
          {
            id: "submitted",
            label: "Submitted",
            statusCategory: "in_review",
            fieldPermissions: {
              project: { department_requester: "edit" },
              dispatch_notes: { department_requester: "hidden", fleet_team: "edit" },
            },
          },
          { id: "rejected", label: "Rejected", statusCategory: "rejected" },
        ],
        transitions: [
          { from: "submitted", to: "rejected", roles: ["admin"], reasonRequired: true },
        ],
      };
      const createRes = await request(app).post("/api/forms").send({
        key,
        name: "Test Form",
        schema,
        workflow,
      });
      expect(createRes.status).toBe(201);
      expect(createRes.body.version.version).toBe(1);

      const publishRes = await request(app).post(
        `/api/forms/versions/${createRes.body.version.id}/publish`,
      );
      expect(publishRes.status).toBe(200);
      expect(publishRes.body.status).toBe("published");

      const submitRes = await request(app)
        .post(`/api/forms/${key}/submissions`)
        .set("x-user-role", "department_requester")
        .send({ data: { department: "IT", project: "Test project", vehicleId: vehicleRes.body.id } });
      expect(submitRes.status).toBe(201);
      expect(submitRes.body.formVersionId).toBe(createRes.body.version.id);
      expect(submitRes.body.stage).toBe("submitted");
      expect(submitRes.body.labelSnapshots.department).toEqual({ code: "IT", label: "Information Technology" });
      expect(submitRes.body.labelSnapshots.vehicleId).toEqual({ code: vehicleRes.body.id, label: plateNumber });

      const reportRes = await request(app).get(`/api/forms/${key}/submissions/report`);
      expect(reportRes.status).toBe(200);
      expect(reportRes.body[0].data).toEqual({ department: "IT", vehicleId: vehicleRes.body.id });
      expect(reportRes.body[0].data.project).toBeUndefined();

      const requesterEdit = await request(app)
        .patch(`/api/forms/submissions/${submitRes.body.id}/data`)
        .set("x-user-role", "department_requester")
        .send({ data: { project: "Updated project" } });
      expect(requesterEdit.status, JSON.stringify(requesterEdit.body)).toBe(200);

      const requesterDispatchTamper = await request(app)
        .patch(`/api/forms/submissions/${submitRes.body.id}/data`)
        .set("x-user-role", "department_requester")
        .send({ data: { dispatch_notes: "Tampered dispatch detail" } });
      expect(requesterDispatchTamper.status).toBe(403);

      const fleetDispatchEdit = await request(app)
        .patch(`/api/forms/submissions/${submitRes.body.id}/data`)
        .set("x-user-role", "fleet_team")
        .send({ data: { dispatch_notes: "Vehicle assigned" } });
      expect(fleetDispatchEdit.status).toBe(200);

      const tamperedRes = await request(app)
        .post(`/api/forms/${key}/submissions`)
        .set("x-user-role", "department_requester")
        .send({ data: { department: "IT", project: "Test project", vehicleId: vehicleRes.body.id, unknown_field: "tampered" } });
      expect(tamperedRes.status).toBe(422);

      const unauthorizedTransition = await request(app)
        .post(`/api/forms/submissions/${submitRes.body.id}/transition`)
        .set("x-user-role", "department_requester")
        .send({ toStage: "rejected", comment: "Not authorized" });
      expect(unauthorizedTransition.status).toBe(403);

      const missingReason = await request(app)
        .post(`/api/forms/submissions/${submitRes.body.id}/transition`)
        .send({ toStage: "rejected" });
      expect(missingReason.status).toBe(400);

      const transitionRes = await request(app)
        .post(`/api/forms/submissions/${submitRes.body.id}/transition`)
        .send({ toStage: "rejected", comment: "Request details were incomplete" });
      expect(transitionRes.status).toBe(200);
      expect(transitionRes.body.status).toBe("rejected");

      const eventsRes = await request(app).get(`/api/forms/submissions/${submitRes.body.id}/events`);
      expect(eventsRes.status).toBe(200);
      expect(eventsRes.body).toHaveLength(4);
      expect(eventsRes.body[3].comment).toBe("Request details were incomplete");

      const getRes = await request(app).get(`/api/forms/${key}`);
      expect(getRes.status).toBe(200);
      expect(getRes.body.versions[0].status).toBe("published");

      const draftRes = await request(app)
        .post(`/api/forms/${createRes.body.id}/versions`)
        .send({ schema: { ...schema, version: 2 } });
      expect(draftRes.status).toBe(201);

      const managerRead = await request(app)
        .get(`/api/forms/${key}`)
        .set("x-user-role", "department_requester");
      expect(managerRead.status).toBe(403);

      const publicRead = await request(app)
        .get(`/api/forms/published/${key}`)
        .set("x-user-role", "department_requester");
      expect(publicRead.status).toBe(200);
      expect(publicRead.body.versions).toHaveLength(1);
      expect(publicRead.body.versions[0].version).toBe(1);
    });

    it("should deny form management to requestors and reject invalid schemas at publish time", async () => {
      const forbidden = await request(app)
        .post("/api/forms")
        .set("x-user-role", "department_requester")
        .send({ key: "forbidden", name: "Forbidden", schema: {} });
      expect(forbidden.status).toBe(403);

      const key = `invalid-form-${Date.now()}`;
      const invalidSchema = {
        key,
        name: "Invalid Form",
        sections: [
          {
            id: "request",
            title: "Request",
            fields: [
              {
                id: "a",
                key: "duplicate",
                type: "text",
                label: "First",
                section: "request",
              },
              {
                id: "b",
                key: "duplicate",
                type: "text",
                label: "Second",
                section: "request",
              },
            ],
          },
        ],
      };
      const created = await request(app)
        .post("/api/forms")
        .send({ key, name: "Invalid Form", schema: invalidSchema });
      expect(created.status).toBe(201);

      const published = await request(app).post(
        `/api/forms/versions/${created.body.version.id}/publish`,
      );
      expect(published.status).toBe(422);
      expect(published.body.details).toContain(
        'Field key "duplicate" is duplicated.',
      );
    });
  });

  describe("Module B: Vehicle Registry & PMS Calculations", () => {
    let testVehicleId: string;

    it("should register a new vehicle with active status", async () => {
      const plate = `TEST-${Math.floor(1000 + Math.random() * 9000)}`;
      const res = await request(app).post("/api/vehicles").send({
        plateNumber: plate,
        model: "Toyota HiAce Commuter",
        vehicleType: "commuter_van",
        assignedDriver: "Juan Dela Cruz",
        currentKm: 1000,
        lastPmsKm: 0,
        pmsIntervalKm: 5000,
      });

      expect(res.status).toBe(201);
      expect(res.body.plateNumber).toBe(plate);
      expect(res.body.status).toBe("active");
      testVehicleId = res.body.id;
    });

    it("should list vehicles and include computed PMS status", async () => {
      const res = await request(app).get("/api/vehicles");
      expect(res.status).toBe(200);
      expect(Array.isArray(res.body)).toBe(true);
      const found = res.body.find((v: any) => v.id === testVehicleId);
      expect(found).toBeDefined();
      expect(found.computedPmsStatus).toBe("active");
      expect(found.nextPmsDueKm).toBe(5000);
    });

    it("should flag vehicle as pms_due when odometer passes threshold", async () => {
      const res = await request(app)
        .post(`/api/vehicles/${testVehicleId}/mileage`)
        .send({ endingKm: 5200 });

      expect(res.status).toBe(200);
      expect(res.body.status).toBe("pms_due");
      expect(res.body.currentKm).toBe(5200);
    });
  });

  describe("Module A: TSRF Requests & 4:00 PM Cutoff", () => {
    it("should flag TSRF as isFlaggedAfterCutoff if submitted after 16:00", async () => {
      // 16:30 submission simulation
      const lateTime = new Date("2026-09-23T16:30:00");
      const res = await request(app)
        .post("/api/tsrf")
        .send({
          department: "IT Support",
          projectName: "Asset Retrieval and KE Biometric Project",
          origin: "MMG Warehouse",
          destination: "Kingston Excell",
          stops: [
            {
              stopOrder: 1,
              locationName: "MMG Warehouse",
              address: "Building 4, MMG Complex",
              waitingTimeMinutes: 15,
            },
            {
              stopOrder: 2,
              locationName: "Kingston Excell",
              address: "Kingston Industrial Park",
              waitingTimeMinutes: 30,
            },
          ],
          passengers: [
            { name: "John Doe", department: "IT", role: "Hardware Tech" },
            {
              name: "Jane Smith",
              department: "Operations",
              role: "Asset Auditor",
            },
          ],
          cargo: [
            {
              description: "KE Biometric Terminals",
              quantity: 10,
              isFragile: true,
            },
          ],
          vehicleType: "commuter_van",
          departureDate: "2026-09-24T08:00:00",
          callTime: "07:30 AM",
          submissionDate: lateTime.toISOString(),
        });

      expect(res.status).toBe(201);
      expect(res.body.isFlaggedAfterCutoff).toBe(true);
      expect(res.body.cutoffReason).toContain(
        "after the daily cut-off time (16:00)",
      );
    });

    it("should not flag TSRF if submitted before 16:00", async () => {
      const earlyTime = new Date("2026-09-23T14:15:00");
      const res = await request(app).post("/api/tsrf").send({
        department: "Logistics",
        projectName: "Regional Hub Delivery",
        origin: "Central Depot",
        destination: "North Hub",
        departureDate: "2026-09-25T09:00:00",
        callTime: "08:30 AM",
        submissionDate: earlyTime.toISOString(),
      });

      expect(res.status).toBe(201);
      expect(res.body.isFlaggedAfterCutoff).toBe(false);
      expect(res.body.cutoffReason).toBeNull();
    });
  });

  describe("Module C: Centralized PR Gatekeeper & Procurement Integration", () => {
    let vehicleId: string;
    let workOrderId: string;
    let prId: string;

    beforeAll(async () => {
      const vRes = await request(app)
        .post("/api/vehicles")
        .send({
          plateNumber: `PR-GATE-${Math.floor(1000 + Math.random() * 9000)}`,
          model: "Isuzu Elf 6W",
          vehicleType: "truck_6w",
          currentKm: 3000,
          lastPmsKm: 0,
          pmsIntervalKm: 5000,
        });
      vehicleId = vRes.body.id;

      // Create a Purchase Requisition (starts pending)
      const prRes = await request(app).post("/api/procurement/pr").send({
        department: "Fleet Operations",
        purpose: "Brake pads and rotor replacement",
        amount: 25000,
      });
      prId = prRes.body.id;
    });

    it("should create repair work order locked in pending PR approval", async () => {
      const woRes = await request(app).post("/api/maintenance/repair").send({
        vehicleId,
        description: "Brake pad replacement and hydraulic fluid flush",
        linkedPrId: prId,
      });

      expect(woRes.status).toBe(201);
      expect(woRes.body.order.procurementFulfillmentStatus).toBe(
        "pending_pr_approval",
      );
      workOrderId = woRes.body.order.id;
    });

    it("should BLOCK work order unlock when linked PR is still pending", async () => {
      const unlockRes = await request(app)
        .post(`/api/maintenance/work-order/${workOrderId}/unlock`)
        .send({ prId });

      expect(unlockRes.status).toBe(403);
      expect(unlockRes.body.error).toBe("PR Gating Block");
      expect(unlockRes.body.message).toContain('must be in "approved" status');
    });

    it("should UNLOCK work order once Finance approves the PR", async () => {
      // Step 1: Finance approves PR
      const approveRes = await request(app)
        .patch(`/api/procurement/pr/${prId}/approve`)
        .send({ approverName: "Jane Finance Officer" });

      expect(approveRes.status).toBe(200);
      expect(approveRes.body.status).toBe("approved");

      // Step 2: Unlock work order through PR Gatekeeper
      const unlockRes = await request(app)
        .post(`/api/maintenance/work-order/${workOrderId}/unlock`)
        .send({ prId });

      expect(unlockRes.status).toBe(200);
      expect(unlockRes.body.status).toBe("unlocked");
      expect(unlockRes.body.order.procurementFulfillmentStatus).toBe(
        "pr_approved",
      );
    });

    it("should allow Procurement to advance fulfillment status through completion to vehicle operational", async () => {
      const unauthorized = await request(app)
        .patch(`/api/procurement/orders/${workOrderId}/status`)
        .set("x-user-role", "department_requester")
        .send({ status: "in_maintenance" });
      expect(unauthorized.status).toBe(403);

      const invalidJump = await request(app)
        .patch(`/api/procurement/orders/${workOrderId}/status`)
        .set("x-user-role", "procurement")
        .send({ status: "vehicle_operational" });
      expect(invalidJump.status).toBe(409);

      const unchangedOrders = await request(app)
        .get("/api/procurement/orders")
        .set("x-user-role", "procurement");
      const unchangedOrder = unchangedOrders.body.find(
        (order: { id: string }) => order.id === workOrderId,
      );
      expect(unchangedOrder.procurementFulfillmentStatus).toBe("pr_approved");

      const vehicleBeforeCompletion = await request(app).get(
        `/api/vehicles/${vehicleId}`,
      );
      expect(vehicleBeforeCompletion.body.status).toBe("in_maintenance");

      // 1. Move to in_maintenance
      const step1 = await request(app)
        .patch(`/api/procurement/orders/${workOrderId}/status`)
        .set("x-user-role", "procurement")
        .send({ status: "in_maintenance" });
      expect(step1.status).toBe(200);
      expect(step1.body.procurementFulfillmentStatus).toBe("in_maintenance");

      // 2. Move to work_completed
      const step2 = await request(app)
        .patch(`/api/procurement/orders/${workOrderId}/status`)
        .set("x-user-role", "procurement")
        .send({ status: "work_completed" });
      expect(step2.status).toBe(200);
      expect(step2.body.procurementFulfillmentStatus).toBe("work_completed");
      const vehicleBeforeRelease = await request(app).get(
        `/api/vehicles/${vehicleId}`,
      );
      expect(vehicleBeforeRelease.body.status).toBe("in_maintenance");

      // 3. Move to vehicle_operational -> resets vehicle status to active
      const step3 = await request(app)
        .patch(`/api/procurement/orders/${workOrderId}/status`)
        .set("x-user-role", "procurement")
        .send({ status: "vehicle_operational" });
      expect(step3.status).toBe(200);
      expect(step3.body.procurementFulfillmentStatus).toBe(
        "vehicle_operational",
      );

      // Verify vehicle status is active again
      const vCheck = await request(app).get(`/api/vehicles/${vehicleId}`);
      expect(vCheck.body.status).toBe("active");
    });

    it("should return 404 for a missing procurement work order", async () => {
      const response = await request(app)
        .patch(`/api/procurement/orders/${randomUUID()}/status`)
        .set("x-user-role", "procurement")
        .send({ status: "in_maintenance" });
      expect(response.status).toBe(404);
    });
  });
});
