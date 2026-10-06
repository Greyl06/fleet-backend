import { describe, it, expect, beforeAll, afterAll } from "vitest";
import request from "supertest";
import { app } from "../src/app.js";
import { ensureDatabaseAndTables } from "../src/db/migrate.js";
import { pool } from "../src/db/connection.js";
import { randomUUID } from "node:crypto";
import { db } from "../src/db/connection.js";
import { lovItems, lovLists, users } from "../src/db/schema.js";
import { eq, and } from "drizzle-orm";

async function temporarilyAssignDepartmentApprover(
  code: string,
): Promise<() => Promise<void>> {
  const [departmentList] = await db
    .select({ id: lovLists.id })
    .from(lovLists)
    .where(eq(lovLists.code, "DEPARTMENTS"));
  const [department] = departmentList
    ? await db
        .select()
        .from(lovItems)
        .where(
          and(eq(lovItems.listId, departmentList.id), eq(lovItems.code, code)),
        )
    : [];
  const [administrator] = await db
    .select({ id: users.id })
    .from(users)
    .where(eq(users.email, "superadmin@hulma.com"));
  if (!department || !administrator)
    throw new Error("Department test setup is missing seeded records.");
  const previousApprovalUserId = department.approvalUserId;
  await db
    .update(lovItems)
    .set({ approvalUserId: administrator.id })
    .where(eq(lovItems.id, department.id));
  return async () => {
    await db
      .update(lovItems)
      .set({ approvalUserId: previousApprovalUserId })
      .where(eq(lovItems.id, department.id));
  };
}

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

      const futureCode = `FUTURE_${Date.now()}`;
      const futureItem = await request(app)
        .post("/api/lov/lists/DEPARTMENTS/items")
        .send({
          code: futureCode,
          label: "Future Department",
          effectiveFrom: new Date(Date.now() + 86_400_000).toISOString(),
          attrs: { head: "Future Head" },
        });
      expect(futureItem.status).toBe(201);
      const activeItems = await request(app).get(
        "/api/lov/lists/DEPARTMENTS/items?status=active",
      );
      expect(
        activeItems.body.some(
          (item: { code: string }) => item.code === futureCode,
        ),
      ).toBe(false);
      const catalogItems = await request(app).get(
        "/api/lov/lists/DEPARTMENTS/items",
      );
      expect(
        catalogItems.body.some(
          (item: { code: string }) => item.code === futureCode,
        ),
      ).toBe(true);
      const legacyFutureDepartmentRequest = await request(app)
        .post("/api/tsrf")
        .set("x-user-role", "department_requester")
        .send({
          department: futureCode,
          projectName: "Future department test",
          origin: "Origin",
          destination: "Destination",
          departureDate: "2026-10-07T08:00:00.000Z",
          callTime: "08:00",
          submissionDate: "2026-01-01T00:00:00.000Z",
        });
      expect(legacyFutureDepartmentRequest.status).toBe(400);

      const deniedWrite = await request(app)
        .post("/api/lov/lists/DEPARTMENTS/items")
        .set("x-user-role", "department_requester")
        .send({ code: "DENIED", label: "Denied" });
      expect(deniedWrite.status).toBe(403);

      const unknownAttribute = await request(app)
        .post("/api/lov/lists/DEPARTMENTS/items")
        .send({
          code: `INVALID_ATTR_${Date.now()}`,
          label: "Invalid Attribute Department",
          attrs: { unconfigured: "value" },
        });
      expect(unknownAttribute.status).toBe(400);

      const wrongAttributeType = await request(app)
        .post("/api/lov/lists/DEPARTMENTS/items")
        .send({
          code: `INVALID_TYPE_${Date.now()}`,
          label: "Invalid Type Department",
          attrs: { head: 42 },
        });
      expect(wrongAttributeType.status).toBe(400);

      const hierarchyNotSupported = await request(app)
        .post("/api/lov/lists/DEPARTMENTS/items")
        .send({
          code: `INVALID_PARENT_${Date.now()}`,
          label: "Invalid Parent Department",
          parentId: "00000000-0000-4000-8000-000000000001",
          attrs: { head: "Test Head" },
        });
      expect(hierarchyNotSupported.status).toBe(400);

      const invalidEffectiveRange = await request(app)
        .post("/api/lov/lists/DEPARTMENTS/items")
        .send({
          code: `INVALID_DATES_${Date.now()}`,
          label: "Invalid Dates Department",
          effectiveFrom: "2026-12-01T00:00:00.000Z",
          effectiveTo: "2026-11-01T00:00:00.000Z",
          attrs: { head: "Test Head" },
        });
      expect(invalidEffectiveRange.status).toBe(400);

      const invalidVehicleCategory = await request(app)
        .post("/api/lov/lists/VEHICLE_TYPES/items")
        .send({
          code: `INVALID_CATEGORY_${Date.now()}`,
          label: "Invalid Vehicle Category",
          attrs: { category: "unknown", pms_interval_km: 5000 },
        });
      expect(invalidVehicleCategory.status).toBe(400);

      const missingRequiredVehicleAttribute = await request(app)
        .post("/api/lov/lists/VEHICLE_TYPES/items")
        .send({
          code: `MISSING_CATEGORY_${Date.now()}`,
          label: "Missing Vehicle Category",
          attrs: { pms_interval_km: 5000 },
        });
      expect(missingRequiredVehicleAttribute.status).toBe(400);

      const hierarchyCode = `HIERARCHY_${Date.now()}`;
      const hierarchyList = await request(app)
        .post("/api/lov/lists")
        .send({
          code: hierarchyCode,
          name: "Test Hierarchy",
          supportsHierarchy: true,
        });
      expect(hierarchyList.status).toBe(201);
      const rootItem = await request(app)
        .post(`/api/lov/lists/${hierarchyCode}/items`)
        .send({ code: "ROOT", label: "Root" });
      expect(rootItem.status).toBe(201);
      const childItem = await request(app)
        .post(`/api/lov/lists/${hierarchyCode}/items`)
        .send({ code: "CHILD", label: "Child", parentId: rootItem.body.id });
      expect(childItem.status).toBe(201);
      const hierarchyCycle = await request(app)
        .put(`/api/lov/items/${rootItem.body.id}`)
        .send({ parentId: childItem.body.id });
      expect(hierarchyCycle.status).toBe(400);

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

      const invalidItemUpdate = await request(app)
        .put(`/api/lov/items/${itemRes.body.id}`)
        .send({ attrs: { unconfigured: "value" } });
      expect(invalidItemUpdate.status).toBe(400);

      const validItemUpdate = await request(app)
        .put(`/api/lov/items/${itemRes.body.id}`)
        .send({ label: "Updated Test Department" });
      expect(validItemUpdate.status).toBe(200);
      expect(validItemUpdate.body.attrs.head).toBe("Test Head");

      const deactivateRes = await request(app).delete(
        `/api/lov/items/${itemRes.body.id}`,
      );
      expect(deactivateRes.status).toBe(200);
      expect(deactivateRes.body.status).toBe("inactive");
    });
  });

  describe("Role management authorization", () => {
    it("should keep role policy writes admin-only and disabled until wired", async () => {
      const mutations = () => [
        request(app).post("/api/roles").send({ key: "test", label: "Test" }),
        request(app).put("/api/roles/test-role").send({ label: "Test" }),
        request(app).delete("/api/roles/test-role"),
        request(app)
          .post("/api/roles/permissions")
          .send({ key: "test:permission", label: "Test" }),
        request(app)
          .put("/api/roles/permissions/test:permission")
          .send({ label: "Test" }),
        request(app).delete("/api/roles/permissions/test:permission"),
      ];

      const responses = await Promise.all(
        mutations().map((mutation) =>
          mutation.set("x-user-role", "department_requester"),
        ),
      );

      expect(responses.map((response) => response.status)).toEqual(
        Array(6).fill(403),
      );

      const adminResponses = await Promise.all(
        mutations().map((mutation) => mutation.set("x-user-role", "admin")),
      );
      expect(adminResponses.map((response) => response.status)).toEqual(
        Array(6).fill(409),
      );
    });
  });

  describe("Legacy reference data authorization", () => {
    it("should deny non-admin reference data mutations", async () => {
      const responses = await Promise.all([
        request(app)
          .post("/api/reference-data/vendors")
          .set("x-user-role", "department_requester")
          .send({ name: "Denied Vendor" }),
        request(app)
          .put("/api/reference-data/vendors/test-id")
          .set("x-user-role", "department_requester")
          .send({ name: "Denied Vendor" }),
        request(app)
          .delete("/api/reference-data/vendors/test-id")
          .set("x-user-role", "department_requester"),
      ]);
      expect(responses.map((response) => response.status)).toEqual([
        403, 403, 403,
      ]);
    });
  });

  describe("Versioned Form Definitions", () => {
    it("allows only the owner to edit and resubmit a returned submission", async () => {
      const key = `returned-form-${Date.now()}`;
      const ownerId = `returned-owner-${Date.now()}`;
      const schema = {
        key,
        name: "Returned Form",
        version: 1,
        status: "draft",
        sections: [
          {
            id: "request",
            title: "Request",
            fields: [
              {
                id: "project",
                key: "project",
                type: "text",
                label: "Project",
                section: "request",
                required: true,
              },
              {
                id: "passengers",
                key: "passengers",
                type: "repeater",
                label: "Passengers",
                section: "request",
                rowFields: [
                  {
                    id: "passenger-name",
                    key: "name",
                    type: "text",
                    label: "Name",
                    section: "passenger",
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
            },
          },
          {
            id: "returned",
            label: "Returned",
            statusCategory: "returned",
            fieldPermissions: {
              project: { department_requester: "edit" },
              passengers: { department_requester: "read" },
              "passengers.name": { department_requester: "edit" },
              "passengers.role": { department_requester: "read" },
            },
          },
        ],
        transitions: [
          {
            from: "submitted",
            to: "returned",
            roles: ["admin"],
            reasonRequired: true,
          },
          {
            from: "returned",
            to: "submitted",
            roles: ["department_requester"],
            action: "resubmitted",
          },
        ],
      };
      const createRes = await request(app).post("/api/forms").send({
        key,
        name: "Returned Form",
        schema,
        workflow,
      });
      expect(createRes.status).toBe(201);
      const publishRes = await request(app).post(
        `/api/forms/versions/${createRes.body.version.id}/publish`,
      );
      expect(publishRes.status).toBe(200);

      const ownerHeaders = {
        "x-user-role": "department_requester",
        "x-user-id": ownerId,
      };
      const submitRes = await request(app)
        .post(`/api/forms/${key}/submissions`)
        .set(ownerHeaders)
        .send({
          data: {
            project: "Original project",
            passengers: [{ name: "Ana", role: "Driver" }],
          },
        });
      expect(submitRes.status).toBe(201);

      const activeEdit = await request(app)
        .patch(`/api/forms/submissions/${submitRes.body.id}/data`)
        .set(ownerHeaders)
        .send({ data: { project: "Edited too early" } });
      expect(activeEdit.status).toBe(403);

      const returned = await request(app)
        .post(`/api/forms/submissions/${submitRes.body.id}/transition`)
        .send({ toStage: "returned", comment: "Please correct the project." });
      expect(returned.status).toBe(200);
      expect(returned.body.status).toBe("returned");

      const returnedDetail = await request(app)
        .get(`/api/forms/submissions/${submitRes.body.id}`)
        .set(ownerHeaders);
      expect(returnedDetail.status).toBe(200);
      expect(returnedDetail.body.fieldAccess).toEqual({
        project: "edit",
        passengers: "read",
        "passengers.name": "edit",
        "passengers.role": "read",
      });
      expect(returnedDetail.body.data.passengers).toEqual([
        { name: "Ana", role: "Driver" },
      ]);
      expect(returnedDetail.body.resubmitStage).toBe("submitted");

      const ownerEdit = await request(app)
        .patch(`/api/forms/submissions/${submitRes.body.id}/data`)
        .set(ownerHeaders)
        .send({
          data: {
            project: "Corrected project",
            passengers: [{ name: "Ana Reyes" }],
          },
        });
      expect(ownerEdit.status).toBe(200);

      const readOnlyChildTamper = await request(app)
        .patch(`/api/forms/submissions/${submitRes.body.id}/data`)
        .set(ownerHeaders)
        .send({ data: { passengers: [{ name: "Ana Reyes", role: "Admin" }] } });
      expect(readOnlyChildTamper.status).toBe(403);

      const preservedData = await request(app).get(
        `/api/forms/submissions/${submitRes.body.id}`,
      );
      expect(preservedData.body.data.passengers).toEqual([
        { name: "Ana Reyes", role: "Driver" },
      ]);

      const otherOwnerHeaders = {
        "x-user-role": "department_requester",
        "x-user-id": `${ownerId}-other`,
      };
      const otherOwnerEdit = await request(app)
        .patch(`/api/forms/submissions/${submitRes.body.id}/data`)
        .set(otherOwnerHeaders)
        .send({ data: { project: "Unauthorized project" } });
      expect(otherOwnerEdit.status).toBe(404);

      const resubmitted = await request(app)
        .post(`/api/forms/submissions/${submitRes.body.id}/transition`)
        .set(ownerHeaders)
        .send({ toStage: "submitted" });
      expect(resubmitted.status).toBe(200);
      expect(resubmitted.body).toMatchObject({
        stage: "submitted",
        status: "in_review",
      });

      const events = await request(app)
        .get(`/api/forms/submissions/${submitRes.body.id}/events`)
        .set(ownerHeaders);
      expect(events.status).toBe(200);
      expect(events.body.map((event: { action: string }) => event.action)).toContain(
        "data_updated",
      );
      expect(events.body.map((event: { action: string }) => event.action)).toContain(
        "resubmitted",
      );
    });

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
        .get("/api/vehicles")
        .set("x-user-role", "department_requester");
      expect(vehicleLookupRes.status).toBe(200);
      expect(
        vehicleLookupRes.body.some(
          (vehicle: { id: string }) => vehicle.id === vehicleRes.body.id,
        ),
      ).toBe(true);
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
                dataSource: {
                  kind: "entity",
                  entity: "vehicles",
                  valueField: "id",
                  labelField: "plateNumber",
                },
                meta: { reportable: true, pii: false },
              },
              {
                id: "crew",
                key: "crew",
                type: "repeater",
                label: "Crew",
                section: "request",
                rowFields: [
                  {
                    id: "crew-name",
                    key: "name",
                    type: "text",
                    label: "Crew Name",
                    section: "request",
                  },
                  {
                    id: "crew-vehicle",
                    key: "vehicleRef",
                    type: "entity_lookup",
                    label: "Crew Vehicle",
                    section: "request",
                    dataSource: {
                      kind: "entity",
                      entity: "vehicles",
                      valueField: "id",
                      labelField: "plateNumber",
                    },
                  },
                  {
                    id: "crew-private-note",
                    key: "privateNote",
                    type: "text",
                    label: "Private Note",
                    section: "request",
                  },
                ],
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
              dispatch_notes: {
                department_requester: "hidden",
                fleet_team: "edit",
              },
              crew: { department_requester: "read" },
              "crew.name": { department_requester: "edit" },
              "crew.vehicleRef": { department_requester: "read" },
            },
          },
          { id: "rejected", label: "Rejected", statusCategory: "rejected" },
        ],
        transitions: [
          {
            from: "submitted",
            to: "rejected",
            roles: ["admin"],
            reasonRequired: true,
          },
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

      const futureDepartmentCode = `FUTURE_SUBMIT_${Date.now()}`;
      const futureDepartment = await request(app)
        .post("/api/lov/lists/DEPARTMENTS/items")
        .send({
          code: futureDepartmentCode,
          label: "Future Request Department",
          effectiveFrom: new Date(Date.now() + 86_400_000).toISOString(),
          attrs: { head: "Future Head" },
        });
      expect(futureDepartment.status).toBe(201);
      const futureDepartmentSubmission = await request(app)
        .post(`/api/forms/${key}/submissions`)
        .set("x-user-role", "department_requester")
        .send({
          data: {
            department: futureDepartmentCode,
            project: "Future department test",
            vehicleId: vehicleRes.body.id,
          },
        });
      expect(futureDepartmentSubmission.status).toBe(422);
      expect(futureDepartmentSubmission.body.details).toContain(
        'Field "department" has an invalid or inactive option.',
      );

      const restoreDepartmentApprover =
        await temporarilyAssignDepartmentApprover("IT");
      const submitRes = await request(app)
        .post(`/api/forms/${key}/submissions`)
        .set("x-user-role", "department_requester")
        .send({
          data: {
            department: "IT",
            project: "Test project",
            vehicleId: vehicleRes.body.id,
            crew: [
              {
                name: "Crew member",
                vehicleRef: vehicleRes.body.id,
                privateNote: "Confidential note",
              },
            ],
          },
        });
      await restoreDepartmentApprover();
      expect(submitRes.status).toBe(201);
      expect(submitRes.body.formVersionId).toBe(createRes.body.version.id);
      expect(submitRes.body.stage).toBe("submitted");
      expect(submitRes.body.currentAssignee).toMatchObject({
        name: "Super Administrator",
        role: "admin",
      });
      expect(submitRes.body.currentResponsibleRoles).toContain("admin");
      expect(submitRes.body.labelSnapshots.department).toEqual({
        code: "IT",
        label: "Information Technology",
      });
      expect(submitRes.body.labelSnapshots.vehicleId).toEqual({
        code: vehicleRes.body.id,
        label: plateNumber,
      });

      const reportRes = await request(app).get(
        `/api/forms/${key}/submissions/report`,
      );
      expect(reportRes.status).toBe(200);
      expect(reportRes.body[0].data).toEqual({
        department: "IT",
        vehicleId: vehicleRes.body.id,
      });
      expect(reportRes.body[0].data.project).toBeUndefined();
      expect(reportRes.body[0].currentAssignee).toMatchObject({
        name: "Super Administrator",
        role: "admin",
      });
      expect(reportRes.body[0].currentResponsibleRoles).toContain("admin");

      const otherRequesterReport = await request(app)
        .get(`/api/forms/${key}/submissions/report`)
        .set("x-user-role", "department_requester")
        .set("x-user-id", "another-requester");
      expect(otherRequesterReport.status).toBe(200);
      expect(otherRequesterReport.body).toEqual([]);

      const requesterEdit = await request(app)
        .patch(`/api/forms/submissions/${submitRes.body.id}/data`)
        .set("x-user-role", "department_requester")
        .send({ data: { project: "Updated project" } });
      expect(requesterEdit.status).toBe(403);

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

      const ownerDetail = await request(app)
        .get(`/api/forms/submissions/${submitRes.body.id}`)
        .set("x-user-role", "department_requester");
      expect(ownerDetail.status).toBe(200);
      expect(ownerDetail.body.data.project).toBe("Test project");
      expect(ownerDetail.body.fieldAccess).toMatchObject({
        project: "edit",
        "crew.name": "edit",
        "crew.vehicleRef": "read",
      });
      expect(ownerDetail.body.fieldAccess.department).toBeUndefined();
      expect(ownerDetail.body.fieldAccess["crew.privateNote"]).toBeUndefined();
      expect(ownerDetail.body.data.department).toBeUndefined();
      expect(ownerDetail.body.data.vehicleId).toBeUndefined();
      expect(ownerDetail.body.data.dispatch_notes).toBeUndefined();
      expect(ownerDetail.body.data.crew).toEqual([
        { name: "Crew member", vehicleRef: vehicleRes.body.id },
      ]);
      const crewField = ownerDetail.body.formSchema.sections[0].fields.find(
        (field: { key: string }) => field.key === "crew",
      );
      expect(crewField.rowFields.map((field: { key: string }) => field.key)).toEqual([
        "name",
        "vehicleRef",
      ]);
      expect(ownerDetail.body.labelSnapshots.department).toBeUndefined();
      expect(ownerDetail.body.labelSnapshots.vehicleId).toBeUndefined();
      expect(ownerDetail.body.labelSnapshots["crew[0].vehicleRef"]).toEqual({
        code: vehicleRes.body.id,
        label: plateNumber,
      });
      expect(
        ownerDetail.body.formSchema.sections[0].fields.some(
          (field: { key: string }) => field.key === "dispatch_notes",
        ),
      ).toBe(false);
      expect(ownerDetail.body.formSchema.key).toBe(key);
      expect(ownerDetail.body.formSchema.sections).toHaveLength(1);
      expect(ownerDetail.body.currentAssignee).toMatchObject({
        name: "Super Administrator",
        role: "admin",
      });
      expect(ownerDetail.body.currentResponsibleRoles).toContain("admin");
      expect(ownerDetail.body.dataJson).toBeUndefined();
      expect(ownerDetail.body.labelSnapshotsJson).toBeUndefined();

      const otherRequesterHeaders = {
        "x-user-role": "department_requester",
        "x-user-id": "another-requester",
      };
      const otherRequesterDetail = await request(app)
        .get(`/api/forms/submissions/${submitRes.body.id}`)
        .set(otherRequesterHeaders);
      expect(otherRequesterDetail.status).toBe(404);

      const otherRequesterEvents = await request(app)
        .get(`/api/forms/submissions/${submitRes.body.id}/events`)
        .set(otherRequesterHeaders);
      expect(otherRequesterEvents.status).toBe(404);

      const otherRequesterEdit = await request(app)
        .patch(`/api/forms/submissions/${submitRes.body.id}/data`)
        .set(otherRequesterHeaders)
        .send({ data: { project: "Unauthorized update" } });
      expect(otherRequesterEdit.status).toBe(404);

      const tamperedRes = await request(app)
        .post(`/api/forms/${key}/submissions`)
        .set("x-user-role", "department_requester")
        .send({
          data: {
            department: "IT",
            project: "Test project",
            vehicleId: vehicleRes.body.id,
            unknown_field: "tampered",
          },
        });
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
        .send({
          toStage: "rejected",
          comment: "Request details were incomplete",
        });
      expect(transitionRes.status).toBe(200);
      expect(transitionRes.body.status).toBe("rejected");

      const eventsRes = await request(app).get(
        `/api/forms/submissions/${submitRes.body.id}/events`,
      );
      expect(eventsRes.status).toBe(200);
      expect(eventsRes.body).toHaveLength(3);
      expect(eventsRes.body[2].comment).toBe("Request details were incomplete");

      const getRes = await request(app).get(`/api/forms/${key}`);
      expect(getRes.status).toBe(200);
      expect(getRes.body.versions[0].status).toBe("published");

      const draftRes = await request(app)
        .post(`/api/forms/${createRes.body.id}/versions`)
        .send({ schema: { ...schema, version: 2 } });
      expect(draftRes.status).toBe(201);

      const renamedSchema = {
        ...schema,
        sections: schema.sections.map((section) => ({
          ...section,
          fields: section.fields.map((field) =>
            field.id === "project" ? { ...field, key: "project_title" } : field,
          ),
        })),
      };
      const renamedDraft = await request(app)
        .put(`/api/forms/versions/${draftRes.body.id}`)
        .send({ schema: renamedSchema, workflow });
      expect(renamedDraft.status).toBe(200);
      const rejectedKeyChange = await request(app).post(
        `/api/forms/versions/${draftRes.body.id}/publish`,
      );
      expect(rejectedKeyChange.status).toBe(422);
      expect(rejectedKeyChange.body.details).toContain(
        'Published field key "project" must be retained.',
      );

      const relabeledSchema = {
        ...schema,
        sections: schema.sections.map((section) => ({
          ...section,
          fields: section.fields.map((field) =>
            field.id === "project"
              ? { ...field, label: "Project Title" }
              : field,
          ),
        })),
      };
      const relabeledDraft = await request(app)
        .put(`/api/forms/versions/${draftRes.body.id}`)
        .send({ schema: relabeledSchema, workflow });
      expect(relabeledDraft.status).toBe(200);
      const publishedLabelChange = await request(app).post(
        `/api/forms/versions/${draftRes.body.id}/publish`,
      );
      expect(publishedLabelChange.status).toBe(200);

      const managerRead = await request(app)
        .get(`/api/forms/${key}`)
        .set("x-user-role", "department_requester");
      expect(managerRead.status).toBe(403);

      const publicRead = await request(app)
        .get(`/api/forms/published/${key}`)
        .set("x-user-role", "department_requester");
      expect(publicRead.status).toBe(200);
      expect(publicRead.body.versions).toHaveLength(1);
      expect(publicRead.body.versions[0].version).toBe(2);
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
      const restoreDepartmentApprover =
        await temporarilyAssignDepartmentApprover("IT");
      try {
        // 16:30 submission simulation
        const lateTime = new Date("2026-09-23T16:30:00");
        const res = await request(app)
          .post("/api/tsrf")
          .send({
            department: "IT",
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
      } finally {
        await restoreDepartmentApprover();
      }
    });

    it("should not flag TSRF if submitted before 16:00", async () => {
      const restoreDepartmentApprover =
        await temporarilyAssignDepartmentApprover("LOG");
      try {
        const earlyTime = new Date("2026-09-23T14:15:00");
        const res = await request(app).post("/api/tsrf").send({
          department: "LOG",
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
      } finally {
        await restoreDepartmentApprover();
      }
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
