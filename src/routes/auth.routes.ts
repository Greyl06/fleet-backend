import { Router, Request, Response } from 'express';
import { randomBytes } from 'node:crypto';
import argon2 from 'argon2';
import nodemailer from 'nodemailer';
import { and, eq, gt, isNull } from 'drizzle-orm';
import { db } from '../db/connection.js';
import { authIdentities, authSessions, authSignupRequests, localCredentials, passwordResetTokens, users } from '../db/schema.js';
import { requirePermission } from '../middleware/auth.js';
import { mapInternalRole } from '../auth/abilities.js';
import { rateLimitAuthentication } from '../middleware/arcjet.js';
import { config } from '../config/env.js';
import {
  authenticateLocalPassword,
  createLocalSession,
  findActiveUserByEmail,
  findActiveUserById,
  tokenHash,
  toAuthUser,
  writeAuthAudit,
} from '../services/auth.service.js';

export const authRouter = Router();

const signupResponse = { message: 'If signup can be completed, check the email address for a verification link. Verified requests are reviewed by a Fleet administrator.' };
const assignableSignupRoles = new Set([
  'fleet_manager', 'finance_manager', 'procurement_officer',
  'department_requester', 'driver',
]);

const mailer = config.smtpHost
  ? nodemailer.createTransport({
      host: config.smtpHost,
      port: config.smtpPort,
      secure: config.smtpSecure,
      auth: config.smtpUser ? { user: config.smtpUser, pass: config.smtpPassword } : undefined,
    })
  : null;

function setCookie(res: Response, name: string, value: string, maxAge: number, httpOnly: boolean) {
  const options = [
    `${name}=${encodeURIComponent(value)}`,
    'Path=/',
    `SameSite=${config.env === 'production' ? 'None' : 'Lax'}`,
    `Max-Age=${maxAge}`,
    ...(httpOnly ? ['HttpOnly'] : []),
    ...(config.env === 'production' ? ['Secure'] : []),
  ];
  res.append('Set-Cookie', options.join('; '));
}

function clearCookie(res: Response, name: string, httpOnly: boolean) {
  const options = [`${name}=`, 'Path=/', `SameSite=${config.env === 'production' ? 'None' : 'Lax'}`, 'Max-Age=0', ...(httpOnly ? ['HttpOnly'] : []), ...(config.env === 'production' ? ['Secure'] : [])];
  res.append('Set-Cookie', options.join('; '));
}

function publicUser(user: NonNullable<Awaited<ReturnType<typeof findActiveUserById>>>) {
  const principal = toAuthUser(user);
  if (!principal) throw new Error('User role is not authorized');
  return { ...principal, email: user.email };
}

authRouter.post('/local/login', rateLimitAuthentication, async (req: Request, res: Response) => {
  const email = typeof req.body?.email === 'string' ? req.body.email : '';
  const password = typeof req.body?.password === 'string' ? req.body.password : '';
  try {
    const principal = await authenticateLocalPassword(email, password);
    if (!principal) {
      await writeAuthAudit('local_login_failed', undefined, 'warning');
      res.status(401).json({ error: 'Invalid email or password.' });
      return;
    }
    const sessionToken = randomBytes(32).toString('base64url');
    const csrfToken = randomBytes(32).toString('base64url');
    const session = await createLocalSession(principal.user.id, sessionToken, csrfToken);
    const maxAge = config.sessionTtlHours * 60 * 60;
    setCookie(res, 'fleet_session', sessionToken, maxAge, true);
    setCookie(res, 'fleet_csrf', csrfToken, maxAge, false);
    await db.update(users).set({ lastActive: new Date() }).where(eq(users.id, principal.user.id));
    await writeAuthAudit('local_login_succeeded', principal.user);
    const user = await findActiveUserById(principal.user.id);
    res.json({ user: user ? publicUser(user) : principal.user, expiresAt: session.expiresAt });
  } catch {
    res.status(500).json({ error: 'Unable to sign in.' });
  }
});

authRouter.get('/me', async (req: Request, res: Response) => {
  if (!req.user) {
    res.status(401).json({ error: 'Authentication required.' });
    return;
  }
  const user = await findActiveUserById(req.user.id);
  if (!user) {
    res.status(401).json({ error: 'Authentication required.' });
    return;
  }
  res.json({ ...req.user, email: user.email, authMethod: req.authMethod });
});

authRouter.post('/local/logout', async (req: Request, res: Response) => {
  if (req.authSessionId) {
    await db.update(authSessions).set({ revokedAt: new Date() }).where(eq(authSessions.id, req.authSessionId));
  }
  if (req.user) await writeAuthAudit('logout', req.user);
  clearCookie(res, 'fleet_session', true);
  clearCookie(res, 'fleet_csrf', false);
  res.json({ ok: true });
});

authRouter.post('/local/provision', requirePermission('manage', 'all'), async (req: Request, res: Response) => {
  const { userId, password } = req.body;
  if (typeof userId !== 'string' || typeof password !== 'string' || password.length < 12) {
    res.status(400).json({ error: 'userId and a password of at least 12 characters are required.' });
    return;
  }
  const user = await findActiveUserById(userId);
  if (!user) {
    res.status(404).json({ error: 'Active Fleet user not found.' });
    return;
  }
  const subject = user.email.trim().toLowerCase();
  const [existingIdentity] = await db.select().from(authIdentities).where(and(
    eq(authIdentities.provider, 'local'), eq(authIdentities.issuer, ''), eq(authIdentities.subject, subject),
  ));
  if (existingIdentity && existingIdentity.userId !== user.id) {
    res.status(409).json({ error: 'Local identity is already linked to another Fleet user.' });
    return;
  }
  try {
    const passwordHash = await argon2.hash(password, { type: argon2.argon2id });
    await db.transaction(async (transaction) => {
      await transaction.insert(localCredentials).values({ userId: user.id, passwordHash })
        .onConflictDoUpdate({ target: localCredentials.userId, set: { passwordHash, passwordChangedAt: new Date(), resetRequired: false, updatedAt: new Date() } });
      if (!existingIdentity) await transaction.insert(authIdentities).values({ provider: 'local', issuer: '', subject, userId: user.id });
      await transaction.update(authSessions).set({ revokedAt: new Date() }).where(and(eq(authSessions.userId, user.id), isNull(authSessions.revokedAt)));
    });
    await writeAuthAudit('local_account_provisioned', req.user);
    res.status(204).end();
  } catch {
    res.status(500).json({ error: 'Unable to provision local credentials.' });
  }
});

authRouter.post('/entra/link', requirePermission('manage', 'all'), async (req: Request, res: Response) => {
  const { userId, issuer, subject } = req.body;
  const expectedIssuer = config.entraTenantId ? `https://login.microsoftonline.com/${config.entraTenantId}/v2.0` : '';
  const [subjectTenant, objectId] = typeof subject === 'string' ? subject.split(':') : [];
  if (!config.entraTenantId || typeof userId !== 'string' || issuer !== expectedIssuer || subjectTenant?.toLowerCase() !== config.entraTenantId.toLowerCase() || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(objectId ?? '')) {
    res.status(400).json({ error: 'An active user and valid Entra issuer/tid:oid subject are required.' });
    return;
  }
  const targetUser = await findActiveUserById(userId);
  if (!targetUser) {
    res.status(404).json({ error: 'Active Fleet user not found.' });
    return;
  }
  try {
    const [identity] = await db.insert(authIdentities).values({ provider: 'entra', issuer, subject, userId }).onConflictDoNothing().returning();
    if (!identity) {
      res.status(409).json({ error: 'Entra identity is already linked.' });
      return;
    }
    await writeAuthAudit('entra_identity_linked', req.user);
    res.status(201).json({ id: identity.id, userId: identity.userId, provider: identity.provider });
  } catch {
    res.status(500).json({ error: 'Unable to link Entra identity.' });
  }
});

authRouter.post('/local/password-reset/request', rateLimitAuthentication, async (req: Request, res: Response) => {
  const email = typeof req.body?.email === 'string' ? req.body.email.trim().toLowerCase() : '';
  const genericResponse = { message: 'If the account supports local sign-in, reset instructions will be sent.' };
  try {
    const user = email ? await findActiveUserByEmail(email) : null;
    if (user && mailer) {
      const [credential] = await db.select().from(localCredentials).where(eq(localCredentials.userId, user.id));
      if (credential) {
        const rawToken = randomBytes(32).toString('base64url');
        const expiresAt = new Date(Date.now() + config.passwordResetTtlMinutes * 60_000);
        await db.transaction(async (transaction) => {
          await transaction.update(passwordResetTokens).set({ consumedAt: new Date() }).where(and(
            eq(passwordResetTokens.userId, user.id),
            isNull(passwordResetTokens.consumedAt),
          ));
          await transaction.insert(passwordResetTokens).values({ userId: user.id, tokenHash: tokenHash(rawToken), expiresAt });
        });
        const resetUrl = `${config.frontendOrigin}/reset-password#token=${encodeURIComponent(rawToken)}`;
        await mailer.sendMail({
          from: config.smtpFrom,
          to: user.email,
          subject: 'Fleet Hub password reset',
          text: `Use this one-time link to reset your Fleet Hub password. It expires in ${config.passwordResetTtlMinutes} minutes: ${resetUrl}`,
        });
        await writeAuthAudit('password_reset_requested', toAuthUser(user) ?? undefined);
      }
    }
  } catch {
    await writeAuthAudit('password_reset_delivery_failed', undefined, 'warning').catch(() => {});
  }
  res.status(202).json(genericResponse);
});

authRouter.post('/local/password-reset/consume', rateLimitAuthentication, async (req: Request, res: Response) => {
  const { token, password } = req.body;
  if (typeof token !== 'string' || typeof password !== 'string' || password.length < 12) {
    res.status(400).json({ error: 'A reset token and password of at least 12 characters are required.' });
    return;
  }
  const passwordHash = await argon2.hash(password, { type: argon2.argon2id });
  const reset = await db.transaction(async (transaction) => {
    const [consumed] = await transaction.update(passwordResetTokens)
      .set({ consumedAt: new Date() })
      .where(and(
        eq(passwordResetTokens.tokenHash, tokenHash(token)),
        isNull(passwordResetTokens.consumedAt),
        gt(passwordResetTokens.expiresAt, new Date()),
      ))
      .returning();
    if (!consumed) return null;
    const [user] = await transaction.select().from(users).where(and(eq(users.id, consumed.userId), eq(users.status, 'active')));
    if (!user) return null;
    await transaction.update(localCredentials).set({ passwordHash, passwordChangedAt: new Date(), resetRequired: false, updatedAt: new Date() }).where(eq(localCredentials.userId, consumed.userId));
    await transaction.update(authSessions).set({ revokedAt: new Date() }).where(and(eq(authSessions.userId, consumed.userId), isNull(authSessions.revokedAt)));
    return consumed;
  });
  if (!reset) {
    res.status(400).json({ error: 'Reset token is invalid or expired.' });
    return;
  }
  const user = await findActiveUserById(reset.userId);
  await writeAuthAudit('password_reset_completed', user ? toAuthUser(user) ?? undefined : undefined);
  res.json({ ok: true });
});

authRouter.post('/local/signup', rateLimitAuthentication, async (req: Request, res: Response) => {
  const name = typeof req.body?.name === 'string' ? req.body.name.trim() : '';
  const email = typeof req.body?.email === 'string' ? req.body.email.trim().toLowerCase() : '';
  const department = typeof req.body?.department === 'string' ? req.body.department.trim() : '';
  const password = typeof req.body?.password === 'string' ? req.body.password : '';
  if (name.length < 2 || name.length > 120 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || department.length < 2 || department.length > 120 || password.length < 12 || password.length > 128) {
    res.status(400).json({ error: 'Provide a valid name, email, department, and password of 12 to 128 characters.' });
    return;
  }
  if (!mailer) {
    res.status(503).json({ error: 'Signup email verification is not configured.' });
    return;
  }

  try {
    const [existingUser] = await db.select({ id: users.id }).from(users).where(eq(users.email, email));
    if (existingUser) {
      res.status(202).json(signupResponse);
      return;
    }
    const [existingRequest] = await db.select().from(authSignupRequests).where(eq(authSignupRequests.email, email));
    if (existingRequest?.status === 'pending_approval') {
      res.status(202).json(signupResponse);
      return;
    }

    const passwordHash = await argon2.hash(password, { type: argon2.argon2id });
    const rawToken = randomBytes(32).toString('base64url');
    const verificationExpiresAt = new Date(Date.now() + 24 * 60 * 60 * 1000);
    let signupRequestId: string | undefined;
    if (existingRequest) {
      const [updated] = await db.update(authSignupRequests).set({
        name, department, passwordHash, verificationTokenHash: tokenHash(rawToken),
        verificationExpiresAt, emailVerifiedAt: null, status: 'pending_verification', updatedAt: new Date(),
      }).where(and(eq(authSignupRequests.id, existingRequest.id), eq(authSignupRequests.status, 'pending_verification'))).returning({ id: authSignupRequests.id });
      signupRequestId = updated?.id;
    } else {
      const [created] = await db.insert(authSignupRequests).values({
        name, email, department, passwordHash, verificationTokenHash: tokenHash(rawToken), verificationExpiresAt,
      }).onConflictDoNothing().returning({ id: authSignupRequests.id });
      signupRequestId = created?.id;
    }
    if (!signupRequestId) {
      res.status(202).json(signupResponse);
      return;
    }

    const verificationUrl = `${config.frontendOrigin}/signup#signupToken=${encodeURIComponent(rawToken)}`;
    try {
      await mailer.sendMail({
        from: config.smtpFrom,
        to: email,
        subject: 'Verify your Fleet Hub signup',
        text: `Verify your email address within 24 hours to submit your Fleet Hub account request: ${verificationUrl}`,
      });
    } catch {
      await writeAuthAudit('signup_verification_delivery_failed', undefined, 'warning');
    }
    await writeAuthAudit('signup_verification_requested');
    res.status(202).json(signupResponse);
  } catch {
    res.status(500).json({ error: 'Unable to process the signup request.' });
  }
});

authRouter.post('/local/signup/verify', rateLimitAuthentication, async (req: Request, res: Response) => {
  const token = typeof req.body?.token === 'string' ? req.body.token : '';
  if (!token) {
    res.status(400).json({ error: 'A verification token is required.' });
    return;
  }
  const [verified] = await db.update(authSignupRequests).set({
    verificationTokenHash: null,
    emailVerifiedAt: new Date(),
    status: 'pending_approval',
    updatedAt: new Date(),
  }).where(and(
    eq(authSignupRequests.verificationTokenHash, tokenHash(token)),
    eq(authSignupRequests.status, 'pending_verification'),
    gt(authSignupRequests.verificationExpiresAt, new Date()),
  )).returning({ id: authSignupRequests.id });
  if (!verified) {
    res.status(400).json({ error: 'Verification link is invalid or expired.' });
    return;
  }
  await writeAuthAudit('signup_email_verified');
  res.json({ message: 'Email verified. Your account request is awaiting administrator approval.' });
});

authRouter.get('/signup/requests', requirePermission('manage', 'all'), async (_req: Request, res: Response) => {
  const requests = await db.select({
    id: authSignupRequests.id,
    name: authSignupRequests.name,
    email: authSignupRequests.email,
    department: authSignupRequests.department,
    emailVerifiedAt: authSignupRequests.emailVerifiedAt,
    createdAt: authSignupRequests.createdAt,
  }).from(authSignupRequests).where(eq(authSignupRequests.status, 'pending_approval'));
  res.json(requests);
});

authRouter.post('/signup/requests/:id/approve', requirePermission('manage', 'all'), async (req: Request, res: Response) => {
  const role = typeof req.body?.role === 'string' ? req.body.role : '';
  if (!assignableSignupRoles.has(role) || !mapInternalRole(role) || mapInternalRole(role) === 'admin') {
    res.status(400).json({ error: 'Choose a supported non-administrator Fleet role.' });
    return;
  }
  try {
    const approvedUser = await db.transaction(async (transaction) => {
      const [signupRequest] = await transaction.select().from(authSignupRequests).where(and(
        eq(authSignupRequests.id, String(req.params.id)),
        eq(authSignupRequests.status, 'pending_approval'),
      ));
      if (!signupRequest || !signupRequest.emailVerifiedAt) return null;
      const [createdUser] = await transaction.insert(users).values({
        name: signupRequest.name,
        email: signupRequest.email,
        role,
        department: signupRequest.department,
        status: 'active',
      }).returning();
      await transaction.insert(localCredentials).values({ userId: createdUser.id, passwordHash: signupRequest.passwordHash });
      await transaction.insert(authIdentities).values({ provider: 'local', issuer: '', subject: signupRequest.email, userId: createdUser.id });
      await transaction.delete(authSignupRequests).where(eq(authSignupRequests.id, signupRequest.id));
      return createdUser;
    });
    if (!approvedUser) {
      res.status(404).json({ error: 'Verified signup request not found.' });
      return;
    }
    await writeAuthAudit('signup_approved', req.user);
    res.status(201).json({ id: approvedUser.id, name: approvedUser.name, email: approvedUser.email, role: approvedUser.role, department: approvedUser.department, status: approvedUser.status });
  } catch {
    res.status(409).json({ error: 'Signup request could not be approved.' });
  }
});

authRouter.delete('/signup/requests/:id', requirePermission('manage', 'all'), async (req: Request, res: Response) => {
  const [rejected] = await db.delete(authSignupRequests).where(and(
    eq(authSignupRequests.id, String(req.params.id)),
    eq(authSignupRequests.status, 'pending_approval'),
  )).returning({ id: authSignupRequests.id });
  if (!rejected) {
    res.status(404).json({ error: 'Verified signup request not found.' });
    return;
  }
  await writeAuthAudit('signup_rejected', req.user);
  res.status(204).end();
});