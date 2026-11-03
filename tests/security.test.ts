import { randomUUID } from "node:crypto";
import { beforeAll, describe, expect, it } from "vitest";
import request from "supertest";
import { app } from "../src/app.js";
import { ensureDatabaseAndTables } from "../src/db/migrate.js";

const admin = { "x-user-role": "admin", "x-user-name": "Security Admin" };

function approver(department: string, name = "Department Approver") {
  return {
    "x-user-role": "approver",
    "x-user-name": name,
    "x-user-department": department,
  };
}

async function createVehicle(): Promise<string> {
  const response = await request(app)
    .post("/api/vehicles")
    .set(admin)
    .send({
      plateNumber: `SEC-${randomUUID().slice(0, 8)}`,
      model: "Toyota Hilux",
      vehicleType: "pickup",
      currentKm: 1000,
      lastPmsKm: 0,
      pmsIntervalKm: 5000,
    });
  expect(response.status).toBe(201);
  return response.body.id;
}

async function createPr(department: string): Promise<string> {
  const response = await request(app)
    .post("/api/procurement/pr")
    .set(admin)
    .send({ department, purpose: "Security regression parts", amount: 1000 });
  expect(response.status).toBe(201);
  return response.body.id;
}

async function createWorkOrder(vehicleId: string, linkedPrId?: string) {
  return request(app)
    .post("/api/maintenance/repair")
    .set(admin)
    .send({ vehicleId, description: "Security regression repair", linkedPrId });
}

describe("security hardening", () => {
  const department = `Security Dept ${randomUUID().slice(0, 6)}`;

  beforeAll(async () => {
    await ensureDatabaseAndTables();
  });

  describe("purchase requisition object-level authorization", () => {
    it("hides other departments' PRs from approvers and allows their own", async () => {
      const prId = await createPr(department);

      const foreignRead = await request(app)
        .get(`/api/procurement/pr/${prId}`)
        .set(approver("Another Department"));
      expect(foreignRead.status).toBe(404);

      const foreignApprove = await request(app)
        .patch(`/api/procurement/pr/${prId}/approve`)
        .set(approver("Another Department"))
        .send({});
      expect(foreignApprove.status).toBe(404);

      const foreignList = await request(app)
        .get("/api/procurement/pr?limit=500")
        .set(approver("Another Department"));
      expect(foreignList.status).toBe(200);
      expect(foreignList.body.some((pr: { id: string }) => pr.id === prId)).toBe(false);

      const ownList = await request(app)
        .get("/api/procurement/pr?limit=500")
        .set(approver(department.toUpperCase()));
      expect(ownList.body.some((pr: { id: string }) => pr.id === prId)).toBe(true);
      expect(
        ownList.body.every(
          (pr: { department: string }) =>
            pr.department.trim().toLowerCase() === department.toLowerCase(),
        ),
      ).toBe(true);

      const noDepartment = await request(app)
        .get(`/api/procurement/pr/${prId}`)
        .set({ "x-user-role": "approver", "x-user-name": "No Department" });
      expect(noDepartment.status).toBe(404);
    });

    it("records the session identity and refuses repeated approvals", async () => {
      const prId = await createPr(department);

      const approved = await request(app)
        .patch(`/api/procurement/pr/${prId}/approve`)
        .set(approver(`  ${department.toLowerCase()} `, "Real Approver"))
        .send({ approverName: "Spoofed Name" });
      expect(approved.status).toBe(200);
      expect(approved.body.status).toBe("approved");
      expect(approved.body.approvedBy).toBe("Real Approver");

      const replay = await request(app)
        .patch(`/api/procurement/pr/${prId}/approve`)
        .set(admin)
        .send({});
      expect(replay.status).toBe(409);
      expect(replay.body.code).toBe("Conflict");
    });

    it("rejects malformed PR identifiers without database detail", async () => {
      const response = await request(app)
        .get("/api/procurement/pr/not-a-uuid")
        .set(admin);
      expect(response.status).toBe(400);
      expect(response.body.error).toBe("PR id must be a valid UUID.");
    });
  });

  describe("incident report integrity", () => {
    it("binds incidents to the work order's vehicle and the session user", async () => {
      const vehicleId = await createVehicle();
      const otherVehicleId = await createVehicle();
      const workOrder = await createWorkOrder(vehicleId);
      expect(workOrder.status).toBe(201);
      const workOrderId = workOrder.body.order.id;

      const payload = {
        repairWorkOrderId: workOrderId,
        reportedBy: "Someone Else",
        incidentDate: new Date(Date.now() - 60_000).toISOString(),
        reason: "Skipped PMS",
        damagesDescription: "Brake wear",
      };

      const mismatched = await request(app)
        .post("/api/maintenance/incident-report")
        .set({ "x-user-role": "fleet_team", "x-user-name": "Fleet Reporter" })
        .send({ ...payload, vehicleId: otherVehicleId });
      expect(mismatched.status).toBe(400);
      expect(mismatched.body.error).toContain("does not belong");

      const filed = await request(app)
        .post("/api/maintenance/incident-report")
        .set({ "x-user-role": "fleet_team", "x-user-name": "Fleet Reporter" })
        .send({ ...payload, vehicleId });
      expect(filed.status).toBe(201);
      expect(filed.body.reportedBy).toBe("Fleet Reporter");

      const duplicate = await request(app)
        .post("/api/maintenance/incident-report")
        .set({ "x-user-role": "fleet_team", "x-user-name": "Fleet Reporter" })
        .send({ ...payload, vehicleId });
      expect(duplicate.status).toBe(409);
    });

    it("validates the incident payload", async () => {
      const response = await request(app)
        .post("/api/maintenance/incident-report")
        .set(admin)
        .send({
          vehicleId: "not-a-uuid",
          repairWorkOrderId: randomUUID(),
          incidentDate: "2020-01-01",
          reason: "x",
          damagesDescription: "y",
        });
      expect(response.status).toBe(400);
      expect(response.body.code).toBe("ValidationError");
    });
  });

  describe("work order unlock linkage", () => {
    it("refuses a PR other than the one already linked", async () => {
      const vehicleId = await createVehicle();
      const linkedPrId = await createPr(department);
      const unrelatedPrId = await createPr(department);
      await request(app).patch(`/api/procurement/pr/${unrelatedPrId}/approve`).set(admin);

      const workOrder = await createWorkOrder(vehicleId, linkedPrId);
      expect(workOrder.status).toBe(201);

      const response = await request(app)
        .post(`/api/maintenance/work-order/${workOrder.body.order.id}/unlock`)
        .set(admin)
        .send({ prId: unrelatedPrId });
      expect(response.status).toBe(409);
      expect(response.body.error).toContain("different purchase requisition");
    });

    it("prevents one approved PR from unlocking several work orders", async () => {
      const vehicleId = await createVehicle();
      const prId = await createPr(department);
      await request(app).patch(`/api/procurement/pr/${prId}/approve`).set(admin);

      const first = await createWorkOrder(vehicleId, prId);
      const firstUnlock = await request(app)
        .post(`/api/maintenance/work-order/${first.body.order.id}/unlock`)
        .set(admin)
        .send({});
      expect(firstUnlock.status).toBe(200);

      const replay = await request(app)
        .post(`/api/maintenance/work-order/${first.body.order.id}/unlock`)
        .set(admin)
        .send({ prId });
      expect(replay.status).toBe(200);

      const second = await createWorkOrder(vehicleId);
      const reuse = await request(app)
        .post(`/api/maintenance/work-order/${second.body.order.id}/unlock`)
        .set(admin)
        .send({ prId });
      expect(reuse.status).toBe(409);
      expect(reuse.body.error).toContain("already linked");

      const reuseAtCreation = await createWorkOrder(vehicleId, prId);
      expect(reuseAtCreation.status).toBe(409);
    });

    it("limits approvers to PRs in their own department", async () => {
      const vehicleId = await createVehicle();
      const prId = await createPr(department);
      await request(app).patch(`/api/procurement/pr/${prId}/approve`).set(admin);
      const workOrder = await createWorkOrder(vehicleId, prId);

      const foreign = await request(app)
        .post(`/api/maintenance/work-order/${workOrder.body.order.id}/unlock`)
        .set(approver("Another Department"))
        .send({});
      expect(foreign.status).toBe(404);

      const own = await request(app)
        .post(`/api/maintenance/work-order/${workOrder.body.order.id}/unlock`)
        .set(approver(department))
        .send({});
      expect(own.status).toBe(200);
    });
  });

  describe("error disclosure and headers", () => {
    it("returns generic messages for database errors", async () => {
      const response = await request(app).get("/api/vehicles/not-a-uuid").set(admin);
      expect(response.status).toBeGreaterThanOrEqual(400);
      expect(JSON.stringify(response.body)).not.toMatch(/invalid input syntax|uuid|select|from/i);
    });

    it("maps malformed JSON to a client error", async () => {
      const response = await request(app)
        .post("/api/procurement/pr")
        .set(admin)
        .set("Content-Type", "application/json")
        .send("{not json");
      expect(response.status).toBe(400);
      expect(response.body.code).toBe("BadRequest");
    });

    it("sends restrictive security headers on API responses", async () => {
      const response = await request(app).get("/health/live");
      expect(response.headers["content-security-policy"]).toContain("default-src 'none'");
      expect(response.headers["content-security-policy"]).toContain("frame-ancestors 'none'");
      expect(response.headers["x-content-type-options"]).toBe("nosniff");
      expect(response.headers["x-frame-options"]).toBe("DENY");
      expect(response.headers["strict-transport-security"]).toContain("max-age=31536000");
      expect(response.headers["x-powered-by"]).toBeUndefined();
    });
  });
});
