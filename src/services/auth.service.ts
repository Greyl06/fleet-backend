import { createHmac } from 'node:crypto';
import argon2 from 'argon2';
import { and, eq, isNull } from 'drizzle-orm';
import { createRemoteJWKSet, jwtVerify, type JWTPayload } from 'jose';
import { db } from '../db/connection.js';
import { activityLogs, authIdentities, authSessions, localCredentials, users } from '../db/schema.js';
import { config } from '../config/env.js';
import { logger } from '../config/logger.js';
import { mapInternalRole, type AuthUser, type Role } from '../auth/abilities.js';

let entraJwks: ReturnType<typeof createRemoteJWKSet> | null = null;
let jwksTenant = '';

export interface AuthenticatedPrincipal {
  user: AuthUser;
  authMethod: 'entra' | 'local' | 'development';
  sessionId?: string;
  csrfTokenHash?: string;
  claims?: JWTPayload;
}

export function tokenHash(token: string): string {
  if (!config.sessionSecret) throw new Error('AUTH_SESSION_SECRET is required');
  return createHmac('sha256', config.sessionSecret).update(token).digest('hex');
}

export function toAuthUser(user: typeof users.$inferSelect): AuthUser | null {
  if (user.status !== 'active') return null;
  const role = mapInternalRole(user.role);
  if (!role) return null;
  return { id: user.id, name: user.name, role, department: user.department };
}

export async function findActiveUserByEmail(email: string) {
  const [user] = await db.select().from(users).where(eq(users.email, email.trim().toLowerCase()));
  return user?.status === 'active' ? user : null;
}

export async function findActiveUserById(id: string) {
  const [user] = await db.select().from(users).where(eq(users.id, id));
  return user?.status === 'active' ? user : null;
}

export async function authenticateLocalPassword(email: string, password: string): Promise<AuthenticatedPrincipal | null> {
  const user = await findActiveUserByEmail(email);
  if (!user) return null;
  const [credential] = await db.select().from(localCredentials).where(eq(localCredentials.userId, user.id));
  if (!credential || credential.resetRequired || !(await argon2.verify(credential.passwordHash, password))) return null;
  const principal = toAuthUser(user);
  return principal ? { user: principal, authMethod: 'local' } : null;
}

export async function createLocalSession(userId: string, rawToken: string, rawCsrfToken: string) {
  const expiresAt = new Date(Date.now() + config.sessionTtlHours * 60 * 60 * 1000);
  const [session] = await db.insert(authSessions).values({
    userId,
    tokenHash: tokenHash(rawToken),
    csrfTokenHash: tokenHash(rawCsrfToken),
    expiresAt,
  }).returning();
  return session;
}

export async function writeAuthAudit(action: string, user?: AuthUser, severity: 'info' | 'warning' = 'info') {
  try {
    await db.insert(activityLogs).values({
      userName: user?.name ?? 'Unauthenticated',
      userRole: user?.role ?? 'unknown',
      action,
      module: 'Authentication',
      description: action,
      severity,
      metadataJson: user ? JSON.stringify({ userId: user.id }) : '{}',
    });
  } catch (error) {
    logger.error({ error, action }, 'Unable to record authentication audit event');
  }
}

export async function authenticateLocalSession(token: string): Promise<AuthenticatedPrincipal | null> {
  const hashedToken = tokenHash(token);
  const [session] = await db.select().from(authSessions).where(and(
    eq(authSessions.tokenHash, hashedToken),
    isNull(authSessions.revokedAt),
  ));
  if (!session) return null;
  if (session.expiresAt <= new Date()) {
    await db.update(authSessions).set({ revokedAt: new Date() }).where(eq(authSessions.id, session.id));
    return null;
  }
  const [user] = await db.select().from(users).where(eq(users.id, session.userId));
  const principal = user && toAuthUser(user);
  if (!principal) {
    await db.update(authSessions).set({ revokedAt: new Date() }).where(eq(authSessions.id, session.id));
    return null;
  }
  await db.update(authSessions).set({ lastUsedAt: new Date() }).where(eq(authSessions.id, session.id));
  return {
    user: principal,
    authMethod: 'local',
    sessionId: session.id,
    csrfTokenHash: session.csrfTokenHash,
  };
}

export async function authenticateEntraToken(token: string): Promise<AuthenticatedPrincipal | null> {
  if (!config.entraTenantId || !config.entraApiAudience || Object.keys(config.entraRoleMap).length === 0) return null;
  if (!entraJwks || jwksTenant !== config.entraTenantId) {
    entraJwks = createRemoteJWKSet(new URL(`https://login.microsoftonline.com/${config.entraTenantId}/discovery/v2.0/keys`));
    jwksTenant = config.entraTenantId;
  }
  const issuer = `https://login.microsoftonline.com/${config.entraTenantId}/v2.0`;
  const { payload } = await jwtVerify(token, entraJwks, { issuer, audience: config.entraApiAudience });
  if (payload.tid !== config.entraTenantId || typeof payload.oid !== 'string') return null;
  const identityIssuer = typeof payload.iss === 'string' ? payload.iss : issuer;
  const subject = `${payload.tid}:${payload.oid}`;
  const [identity] = await db.select().from(authIdentities).where(and(
    eq(authIdentities.provider, 'entra'),
    eq(authIdentities.issuer, identityIssuer),
    eq(authIdentities.subject, subject),
  ));
  if (!identity) return null;
  const [user] = await db.select().from(users).where(eq(users.id, identity.userId));
  const principal = user && toAuthUser(user);
  if (!principal) return null;

  const claimRoles = Array.isArray(payload.roles) ? payload.roles.filter((role): role is string => typeof role === 'string') : [];
  const mappedRoles = claimRoles.map((role) => config.entraRoleMap[role]).filter((role): role is string => typeof role === 'string').map(mapInternalRole).filter((role): role is Role => role !== null);
  if (mappedRoles.length === 0 || !mappedRoles.includes(principal.role)) return null;

  await db.update(authIdentities).set({ lastUsedAt: new Date() }).where(eq(authIdentities.id, identity.id));
  return { user: principal, authMethod: 'entra', claims: payload };
}
