import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import request from 'supertest';
import argon2 from 'argon2';
import { randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { app } from '../src/app.js';
import { config } from '../src/config/env.js';
import { db, pool } from '../src/db/connection.js';
import { ensureDatabaseAndTables } from '../src/db/migrate.js';
import { authSignupRequests, users } from '../src/db/schema.js';
import { tokenHash } from '../src/services/auth.service.js';
import { rateLimitAuthentication } from '../src/middleware/arcjet.js';

describe('Hybrid authentication and signup approval', () => {
  beforeAll(async () => {
    await ensureDatabaseAndTables();
  });

  afterAll(async () => {
    await pool.end();
  });

  it('rejects identity headers and user mutations when development header auth is disabled', async () => {
    const previousSetting = config.allowDevHeaderAuth;
    config.allowDevHeaderAuth = false;
    try {
      const protectedRequest = await request(app)
        .get('/api/vehicles')
        .set('x-user-role', 'admin')
        .set('x-user-id', 'spoofed-user');
      expect(protectedRequest.status).toBe(401);

      const userMutation = await request(app)
        .post('/api/users')
        .set('x-user-role', 'admin')
        .send({ name: 'Spoofed Admin', email: `spoof-${Date.now()}@example.com`, role: 'admin' });
      expect(userMutation.status).toBe(401);
    } finally {
      config.allowDevHeaderAuth = previousSetting;
    }
  });

  it('isolates local signup throttling from login retries and returns a retry duration', async () => {
    const ip = `auth-limit-${randomUUID()}`;
    const attempt = async (path: string, email: string) => {
      const outcome: { status: number; headers: Record<string, string>; body?: Record<string, unknown> } = {
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
        { ip, path, body: { email } } as unknown as import('express').Request,
        response as unknown as import('express').Response,
        () => undefined,
      );
      return outcome;
    };

    for (let index = 0; index < 50; index += 1) {
      const loginAttempt = await attempt('/api/auth/local/login', `retry-${index}-${randomUUID()}@example.com`);
      expect(loginAttempt.status).toBe(200);
    }
    const blockedLogin = await attempt('/api/auth/local/login', `retry-final-${randomUUID()}@example.com`);
    expect(blockedLogin.status).toBe(429);
    expect(Number(blockedLogin.headers['retry-after'])).toBeGreaterThan(0);
    expect(blockedLogin.body?.message).toContain('Please wait about');

    const signupAttempt = await attempt('/api/auth/local/signup', `signup-${randomUUID()}@example.com`);
    expect(signupAttempt.status).toBe(200);
  });

  it('verifies signup email, requires admin role assignment, and enables login only after approval', async () => {
    const email = `signup-${randomUUID()}@example.com`;
    const password = 'Signup-test-password-2026!';
    const verificationToken = randomUUID();
    const passwordHash = await argon2.hash(password, { type: argon2.argon2id });
    const [signupRequest] = await db.insert(authSignupRequests).values({
      name: 'Signup Test User',
      email,
      department: 'Fleet Operations',
      passwordHash,
      verificationTokenHash: tokenHash(verificationToken),
      verificationExpiresAt: new Date(Date.now() + 60_000),
      status: 'pending_verification',
    }).returning();
    let approvedUserId: string | undefined;
    try {
      const pendingLogin = await request(app).post('/api/auth/local/login').send({ email, password });
      expect(pendingLogin.status).toBe(401);

      const verification = await request(app)
        .post('/api/auth/local/signup/verify')
        .send({ token: verificationToken });
      expect(verification.status).toBe(200);
      expect(verification.body.message).toContain('awaiting administrator approval');

      const queue = await request(app).get('/api/auth/signup/requests').set('x-user-role', 'department_requester');
      expect(queue.status).toBe(403);

      const forbiddenRole = await request(app)
        .post(`/api/auth/signup/requests/${signupRequest.id}/approve`)
        .set('x-user-role', 'admin')
        .send({ role: 'admin' });
      expect(forbiddenRole.status).toBe(400);

      const approval = await request(app)
        .post(`/api/auth/signup/requests/${signupRequest.id}/approve`)
        .set('x-user-role', 'admin')
        .send({ role: 'department_requester' });
      expect(approval.status).toBe(201);
      expect(approval.body.role).toBe('department_requester');
      approvedUserId = approval.body.id;

      const agent = request.agent(app);
      const login = await agent.post('/api/auth/local/login').send({ email, password });
      expect(login.status).toBe(200);
      const currentUser = await agent.get('/api/auth/me');
      expect(currentUser.status).toBe(200);
      expect(currentUser.body.email).toBe(email);
      expect(currentUser.body.role).toBe('department_requester');
    } finally {
      if (approvedUserId) await db.delete(users).where(eq(users.id, approvedUserId));
      await db.delete(authSignupRequests).where(eq(authSignupRequests.id, signupRequest.id));
    }
  });

  it('does not accept client-selected roles during public signup', async () => {
    const response = await request(app).post('/api/auth/local/signup').send({
      name: 'Unverified User',
      email: 'invalid-email',
      department: 'Fleet Operations',
      password: 'Signup-test-password-2026!',
      role: 'admin',
      status: 'active',
    });
    expect(response.status).toBe(400);
  });

  it('returns a local verification link without SMTP and keeps the request pending', async () => {
    const email = `local-signup-${randomUUID()}@example.com`;
    const password = 'Local-signup-password-2026!';
    let signupRequestId: string | undefined;
    try {
      const signup = await request(app).post('/api/auth/local/signup').send({
        name: 'Local Signup User',
        email,
        department: 'Fleet Operations',
        password,
      });
      expect(signup.status).toBe(202);
      expect(signup.body.verificationUrl).toContain('#signupToken=');
      const token = new URLSearchParams(new URL(signup.body.verificationUrl).hash.slice(1)).get('signupToken');
      expect(token).toBeTruthy();

      const verification = await request(app).post('/api/auth/local/signup/verify').send({ token });
      expect(verification.status).toBe(200);
      const pendingLogin = await request(app).post('/api/auth/local/login').send({ email, password });
      expect(pendingLogin.status).toBe(401);
    } finally {
      const [requestRow] = await db.select({ id: authSignupRequests.id })
        .from(authSignupRequests)
        .where(eq(authSignupRequests.email, email));
      signupRequestId = requestRow?.id;
      if (signupRequestId) await db.delete(authSignupRequests).where(eq(authSignupRequests.id, signupRequestId));
    }
  });
});
