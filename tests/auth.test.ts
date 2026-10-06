import { afterAll, beforeAll, describe, expect, it } from "vitest";
import request from "supertest";
import argon2 from "argon2";
import { randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { app } from "../src/app.js";
import { config } from "../src/config/env.js";
import { db, pool } from "../src/db/connection.js";
import { ensureDatabaseAndTables } from "../src/db/migrate.js";
import {
  activityLogs,
  authSignupRequests,
  formDefinitions,
  formSubmissionEvents,
  formSubmissions,
  formVersions,
  lovItems,
  lovLists,
  tsrfRequests,
  users,
} from "../src/db/schema.js";
import { tokenHash } from "../src/services/auth.service.js";
import {
  protectTsrfIntake,
  rateLimitApiWrite,
  rateLimitAuthentication,
  rateLimitFormMutation,
  rateLimitProcurementWrite,
} from "../src/middleware/arcjet.js";

describe("Hybrid authentication and signup approval", () => {
  beforeAll(async () => {
    await ensureDatabaseAndTables();
  });

  afterAll(async () => {
    await pool.end();
  });

  it("rejects identity headers and user mutations when development header auth is disabled", async () => {
    const previousSetting = config.allowDevHeaderAuth;
    config.allowDevHeaderAuth = false;
    try {
      const protectedRequest = await request(app)
        .get("/api/vehicles")
        .set("x-user-role", "admin")
        .set("x-user-id", "spoofed-user");
      expect(protectedRequest.status).toBe(401);

      const userMutation = await request(app)
        .post("/api/users")
        .set("x-user-role", "admin")
        .send({
          name: "Spoofed Admin",
          email: `spoof-${Date.now()}@example.com`,
          role: "admin",
        });
      expect(userMutation.status).toBe(401);
    } finally {
      config.allowDevHeaderAuth = previousSetting;
    }
  });

  it("isolates local signup throttling from login retries and returns a retry duration", async () => {
    const ip = `auth-limit-${randomUUID()}`;
    const attempt = async (path: string, email: string) => {
      const outcome: {
        status: number;
        headers: Record<string, string>;
        body?: Record<string, unknown>;
      } = {
        status: 200,
        headers: {},
      };
      const response = {
        setHeader(name: string, value: string) {
          outcome.headers[name.toLowerCase()] = value;
          return this;
        },
        status(code: number) {
          outcome.status = code;
          return this;
        },
        json(body: Record<string, unknown>) {
          outcome.body = body;
          return this;
        },
      };
      await rateLimitAuthentication(
        { ip, path, body: { email } } as unknown as import("express").Request,
        response as unknown as import("express").Response,
        () => undefined,
      );
      return outcome;
    };

    for (let index = 0; index < 50; index += 1) {
      const loginAttempt = await attempt(
        "/api/auth/local/login",
        `retry-${index}-${randomUUID()}@example.com`,
      );
      expect(loginAttempt.status).toBe(200);
    }
    const blockedLogin = await attempt(
      "/api/auth/local/login",
      `retry-final-${randomUUID()}@example.com`,
    );
    expect(blockedLogin.status).toBe(429);
    expect(Number(blockedLogin.headers["retry-after"])).toBeGreaterThan(0);
    expect(blockedLogin.body?.message).toContain("Please wait about");

    const signupAttempt = await attempt(
      "/api/auth/local/signup",
      `signup-${randomUUID()}@example.com`,
    );
    expect(signupAttempt.status).toBe(200);
  });

  it.skipIf(Boolean(config.arcjetKey))(
    "fails closed for protected writes in production when Arcjet is not configured",
    async () => {
      const previousEnvironment = config.env;
      config.env = "production";
      try {
        for (const middleware of [
          rateLimitApiWrite,
          protectTsrfIntake,
          rateLimitFormMutation,
          rateLimitProcurementWrite,
        ]) {
          const outcome: {
            status: number;
            nextCalled: boolean;
            body?: Record<string, unknown>;
          } = { status: 200, nextCalled: false };
          const response = {
            status(code: number) {
              outcome.status = code;
              return this;
            },
            json(body: Record<string, unknown>) {
              outcome.body = body;
              return this;
            },
          };
          await middleware(
            {
              ip: "arcjet-test",
              path: "/api/tsrf",
              method: "POST",
              body: {},
            } as import("express").Request,
            response as unknown as import("express").Response,
            () => {
              outcome.nextCalled = true;
            },
          );
          expect(outcome.status).toBe(503);
          expect(outcome.nextCalled).toBe(false);
          expect(outcome.body?.message).toContain("protection");
        }
      } finally {
        config.env = previousEnvironment;
      }
    },
  );

  it("verifies signup email, requires admin role assignment, and enables login only after approval", async () => {
    const [reviewer] = await db
      .select({ id: users.id })
      .from(users)
      .where(eq(users.email, "superadmin@hulma.com"));
    expect(reviewer).toBeTruthy();
    const email = `signup-${randomUUID()}@example.com`;
    const password = "Signup-test-password-2026!";
    const verificationToken = randomUUID();
    const passwordHash = await argon2.hash(password, { type: argon2.argon2id });
    const [signupRequest] = await db
      .insert(authSignupRequests)
      .values({
        name: "Signup Test User",
        email,
        department: "Fleet Operations",
        passwordHash,
        verificationTokenHash: tokenHash(verificationToken),
        verificationExpiresAt: new Date(Date.now() + 60_000),
        status: "pending_verification",
      })
      .returning();
    let approvedUserId: string | undefined;
    try {
      const pendingLogin = await request(app)
        .post("/api/auth/local/login")
        .send({ email, password });
      expect(pendingLogin.status).toBe(401);

      const verification = await request(app)
        .post("/api/auth/local/signup/verify")
        .send({ token: verificationToken });
      expect(verification.status).toBe(200);
      expect(verification.body.message).toContain(
        "awaiting administrator approval",
      );

      const awaitingApproval = await request(app)
        .post("/api/auth/local/login")
        .send({ email, password });
      expect(awaitingApproval.status).toBe(403);
      expect(awaitingApproval.body.code).toBe("ACCOUNT_PENDING_APPROVAL");
      expect(awaitingApproval.body.error).toContain(
        "awaiting administrator approval",
      );
      const wrongPassword = await request(app)
        .post("/api/auth/local/login")
        .send({ email, password: "wrong-password" });
      expect(wrongPassword.status).toBe(401);

      const queue = await request(app)
        .get("/api/auth/signup/requests")
        .set("x-user-role", "department_requester");
      expect(queue.status).toBe(403);

      const forbiddenRole = await request(app)
        .post(`/api/auth/signup/requests/${signupRequest.id}/approve`)
        .set("x-user-role", "admin")
        .set("x-user-id", reviewer.id)
        .send({ role: "admin" });
      expect(forbiddenRole.status).toBe(400);

      const approval = await request(app)
        .post(`/api/auth/signup/requests/${signupRequest.id}/approve`)
        .set("x-user-role", "admin")
        .set("x-user-id", reviewer.id)
        .send({ role: "department_requester" });
      expect(approval.status).toBe(201);
      expect(approval.body.role).toBe("department_requester");
      approvedUserId = approval.body.id;

      const agent = request.agent(app);
      const login = await agent
        .post("/api/auth/local/login")
        .send({ email, password });
      expect(login.status).toBe(200);
      const currentUser = await agent.get("/api/auth/me");
      expect(currentUser.status).toBe(200);
      expect(currentUser.body.email).toBe(email);
      expect(currentUser.body.role).toBe("department_requester");

      const userList = await request(app)
        .get("/api/users")
        .set("x-user-role", "admin");
      expect(userList.status).toBe(200);
      expect(
        userList.body.some(
          (user: { id: string }) => user.id === approvedUserId,
        ),
      ).toBe(true);

      const approvedHistory = await request(app)
        .get("/api/auth/signup/requests?status=approved")
        .set("x-user-role", "admin");
      const approvedEntry = approvedHistory.body.find(
        (entry: { id: string }) => entry.id === signupRequest.id,
      );
      expect(approvedEntry.status).toBe("approved");
      expect(approvedEntry.assignedRole).toBe("department_requester");
      expect(approvedEntry).not.toHaveProperty("passwordHash");
    } finally {
      if (approvedUserId)
        await db.delete(users).where(eq(users.id, approvedUserId));
      await db
        .delete(authSignupRequests)
        .where(eq(authSignupRequests.id, signupRequest.id));
    }
  });

  it("does not accept client-selected roles during public signup", async () => {
    const response = await request(app)
      .post("/api/auth/local/signup")
      .send({
        name: "Unverified User",
        email: `unprivileged-${randomUUID()}@example.com`,
        departmentCode: "FLEET",
        requestedRole: "admin",
        password: "Signup-test-password-2026!",
        role: "admin",
        status: "active",
      });
    expect(response.status).toBe(400);
  });

  it("serves signup choices from active backend catalogs", async () => {
    const response = await request(app).get("/api/auth/signup/options");
    expect(response.status).toBe(200);
    expect(response.body.departments).toContainEqual({
      code: "FLEET",
      label: "Fleet Operations",
    });
    expect(
      response.body.roles.some(
        (role: { key: string }) => role.key === "department_requester",
      ),
    ).toBe(true);
    expect(
      response.body.roles.some(
        (role: { key: string }) => role.key === "approver",
      ),
    ).toBe(true);
    expect(
      response.body.roles.every(
        (role: { key: string }) => !["admin", "superadmin"].includes(role.key),
      ),
    ).toBe(true);
  });

  it("returns a local verification link without SMTP and keeps the request pending", async () => {
    const email = `local-signup-${randomUUID()}@example.com`;
    const password = "Local-signup-password-2026!";
    let signupRequestId: string | undefined;
    try {
      const signup = await request(app).post("/api/auth/local/signup").send({
        name: "Local Signup User",
        email,
        departmentCode: "FLEET",
        requestedRole: "department_requester",
        password,
      });
      expect(signup.status).toBe(202);
      expect(signup.body.verificationUrl).toContain("#signupToken=");
      const [savedRequest] = await db
        .select()
        .from(authSignupRequests)
        .where(eq(authSignupRequests.email, email));
      expect(savedRequest.department).toBe("Fleet Operations");
      expect(savedRequest.departmentCode).toBe("FLEET");
      expect(savedRequest.requestedRole).toBe("department_requester");
      const token = new URLSearchParams(
        new URL(signup.body.verificationUrl).hash.slice(1),
      ).get("signupToken");
      expect(token).toBeTruthy();

      const verification = await request(app)
        .post("/api/auth/local/signup/verify")
        .send({ token });
      expect(verification.status).toBe(200);
    } finally {
      const [requestRow] = await db
        .select({ id: authSignupRequests.id })
        .from(authSignupRequests)
        .where(eq(authSignupRequests.email, email));
      signupRequestId = requestRow?.id;
      if (signupRequestId)
        await db
          .delete(authSignupRequests)
          .where(eq(authSignupRequests.id, signupRequestId));
    }
  });

  it("retains rejected signup requests without their password hash", async () => {
    const [reviewer] = await db
      .select({ id: users.id })
      .from(users)
      .where(eq(users.email, "superadmin@hulma.com"));
    expect(reviewer).toBeTruthy();
    const passwordHash = await argon2.hash("Rejected-signup-password-2026!", {
      type: argon2.argon2id,
    });
    const [signupRequest] = await db
      .insert(authSignupRequests)
      .values({
        name: "Rejected Signup User",
        email: `rejected-${randomUUID()}@example.com`,
        department: "Fleet Operations",
        passwordHash,
        verificationTokenHash: null,
        verificationExpiresAt: new Date(Date.now() + 60_000),
        emailVerifiedAt: new Date(),
        status: "pending_approval",
      })
      .returning();
    try {
      const rejection = await request(app)
        .delete(`/api/auth/signup/requests/${signupRequest.id}`)
        .set("x-user-role", "admin")
        .set("x-user-id", reviewer.id);
      expect(rejection.status).toBe(204);

      const rejectedHistory = await request(app)
        .get("/api/auth/signup/requests?status=rejected")
        .set("x-user-role", "admin");
      const rejectedEntry = rejectedHistory.body.find(
        (entry: { id: string }) => entry.id === signupRequest.id,
      );
      expect(rejectedEntry.status).toBe("rejected");
      expect(rejectedEntry).not.toHaveProperty("passwordHash");
    } finally {
      await db
        .delete(authSignupRequests)
        .where(eq(authSignupRequests.id, signupRequest.id));
    }
  });

  it("routes legacy TSRF department approval to the linked department approver", async () => {
    const [departmentList] = await db
      .select({ id: lovLists.id })
      .from(lovLists)
      .where(eq(lovLists.code, "DEPARTMENTS"));
    const [department] = await db
      .select()
      .from(lovItems)
      .where(
        and(eq(lovItems.listId, departmentList.id), eq(lovItems.code, "FLEET")),
      );

    await (async () => {
      const [departmentList] = await db
        .select({ id: lovLists.id })
        .from(lovLists)
        .where(eq(lovLists.code, "DEPARTMENTS"));
      const [department] = await db
        .select()
        .from(lovItems)
        .where(
          and(eq(lovItems.listId, departmentList.id), eq(lovItems.code, "LOG")),
        );
      const [approver] = await db
        .insert(users)
        .values({
          name: "Versioned Department Head Test",
          email: `versioned-head-${randomUUID()}@example.com`,
          role: "approver",
          department: department.label,
          departmentCode: department.code,
          status: "active",
        })
        .returning();
      const previousApproverId = department.approvalUserId;
      await db
        .update(lovItems)
        .set({ approvalUserId: approver.id })
        .where(eq(lovItems.id, department.id));

      const key = `department-head-${randomUUID()}`;
      const [definition] = await db
        .insert(formDefinitions)
        .values({ key, name: "Department Head Test Form" })
        .returning();
      const schema = {
        key,
        name: "Department Head Test Form",
        version: 1,
        status: "published",
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
              },
              {
                id: "project",
                key: "projectName",
                type: "text",
                label: "Project",
                section: "request",
                required: true,
              },
            ],
          },
        ],
      };
      const workflow = {
        initialStage: "submitted",
        stages: [
          { id: "submitted", label: "Submitted", statusCategory: "in_review" },
          {
            id: "endorsement",
            label: "Endorsement",
            statusCategory: "in_review",
          },
        ],
        transitions: [
          {
            from: "submitted",
            to: "endorsement",
            roles: ["approver", "admin"],
          },
        ],
      };
      const [version] = await db
        .insert(formVersions)
        .values({
          formDefinitionId: definition.id,
          version: 1,
          schemaJson: JSON.stringify(schema),
          workflowJson: JSON.stringify(workflow),
          status: "published",
        })
        .returning();
      let submissionId: string | undefined;
      try {
        const submission = await request(app)
          .post(`/api/forms/${key}/submissions`)
          .set("x-user-role", "department_requester")
          .send({
            data: {
              department: department.code,
              projectName: "Head routing verification",
            },
          });
        submissionId = submission.body?.id;
        expect(submission.status, JSON.stringify(submission.body)).toBe(201);
        expect(submission.body.departmentHeadUserId).toBe(approver.id);

        const wrongApprover = await request(app)
          .post(`/api/forms/submissions/${submissionId}/transition`)
          .set("x-user-role", "approver")
          .set("x-user-id", randomUUID())
          .send({ toStage: "endorsement" });
        expect(wrongApprover.status).toBe(403);

        const assignedApprover = await request(app)
          .post(`/api/forms/submissions/${submissionId}/transition`)
          .set("x-user-role", "approver")
          .set("x-user-id", approver.id)
          .send({ toStage: "endorsement" });
        expect(assignedApprover.status).toBe(200);
        expect(assignedApprover.body.stage).toBe("endorsement");
      } finally {
        const existingSubmissions = await db
          .select({ id: formSubmissions.id })
          .from(formSubmissions)
          .where(eq(formSubmissions.formVersionId, version.id));
        for (const submission of existingSubmissions) {
          await db
            .delete(formSubmissionEvents)
            .where(eq(formSubmissionEvents.submissionId, submission.id));
        }
        await db
          .delete(formSubmissions)
          .where(eq(formSubmissions.formVersionId, version.id));
        await db.delete(formVersions).where(eq(formVersions.id, version.id));
        await db
          .delete(formDefinitions)
          .where(eq(formDefinitions.id, definition.id));
        await db
          .update(lovItems)
          .set({ approvalUserId: previousApproverId })
          .where(eq(lovItems.id, department.id));
        await db.delete(users).where(eq(users.id, approver.id));
      }
    })();
    const [approver] = await db
      .insert(users)
      .values({
        name: "Department Head Test",
        email: `department-head-${randomUUID()}@example.com`,
        role: "approver",
        department: department.label,
        departmentCode: department.code,
        status: "active",
      })
      .returning();
    const previousApproverId = department.approvalUserId;
    await db
      .update(lovItems)
      .set({ approvalUserId: approver.id })
      .where(eq(lovItems.id, department.id));
    let tsrfId: string | undefined;
    try {
      const submission = await request(app)
        .post("/api/tsrf")
        .set("x-user-role", "department_requester")
        .send({
          department: department.code,
          projectName: "Department Approval Test",
          origin: "Main Office",
          destination: "Fleet Depot",
          departureDate: "2026-10-20T08:00:00",
          callTime: "07:30 AM",
        });
      expect(submission.status).toBe(201);
      expect(submission.body.departmentHeadUserId).toBe(approver.id);
      tsrfId = submission.body.id;

      const denied = await request(app)
        .patch(`/api/tsrf/${tsrfId}/endorse`)
        .set("x-user-role", "approver")
        .set("x-user-id", randomUUID())
        .send({ role: "department_head", action: "approve" });
      expect(denied.status).toBe(403);

      const approved = await request(app)
        .patch(`/api/tsrf/${tsrfId}/endorse`)
        .set("x-user-role", "approver")
        .set("x-user-id", approver.id)
        .send({ role: "department_head", action: "approve" });
      expect(approved.status).toBe(200);
      expect(approved.body.approvalStatus).toBe("dept_approved");
    } finally {
      await db
        .update(lovItems)
        .set({ approvalUserId: previousApproverId })
        .where(eq(lovItems.id, department.id));
      if (tsrfId)
        await db.delete(tsrfRequests).where(eq(tsrfRequests.id, tsrfId));
      await db.delete(users).where(eq(users.id, approver.id));
    }
  });

  it("persists successful module mutations without storing request bodies in the audit log", async () => {
    const email = `activity-${randomUUID()}@example.com`;
    const actorName = `Audit Admin ${randomUUID()}`;
    let createdUserId: string | undefined;
    try {
      const response = await request(app)
        .post("/api/users")
        .set("x-user-role", "admin")
        .set("x-user-id", randomUUID())
        .set("x-user-name", actorName)
        .send({
          name: "Audit Test User",
          email,
          department: "Fleet Operations",
          role: "department_requester",
          status: "active",
          secret: "do-not-audit-this-value",
        });
      expect(response.status).toBe(201);
      createdUserId = response.body.id;

      let auditEntry: typeof activityLogs.$inferSelect | undefined;
      for (let attempt = 0; attempt < 20 && !auditEntry; attempt += 1) {
        const [entry] = await db
          .select()
          .from(activityLogs)
          .where(
            and(
              eq(activityLogs.userName, actorName),
              eq(activityLogs.action, "Created"),
              eq(activityLogs.module, "User Management"),
            ),
          );
        auditEntry = entry;
        if (!auditEntry)
          await new Promise((resolve) => setTimeout(resolve, 10));
      }
      expect(auditEntry).toBeTruthy();
      expect(auditEntry?.description).toContain("/api/users");
      expect(auditEntry?.metadataJson).not.toContain(email);
      expect(auditEntry?.metadataJson).not.toContain("do-not-audit-this-value");
    } finally {
      if (createdUserId)
        await db.delete(users).where(eq(users.id, createdUserId));
      await db.delete(activityLogs).where(eq(activityLogs.userName, actorName));
    }
  });
});
