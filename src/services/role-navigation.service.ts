import { eq } from "drizzle-orm";
import { db } from "../db/connection.js";
import { roleLoginRedirects } from "../db/schema.js";
import type { Role } from "../auth/abilities.js";
import { effectiveLandingPage } from "../domain/role-navigation.js";

export async function resolveLandingPage(role: Role): Promise<string> {
  const [setting] = await db.select({ landingPage: roleLoginRedirects.landingPage }).from(roleLoginRedirects).where(eq(roleLoginRedirects.roleKey, role));
  return effectiveLandingPage(role, setting?.landingPage);
}