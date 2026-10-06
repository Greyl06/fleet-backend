import argon2 from "argon2";
import { and, eq, sql } from "drizzle-orm";
import { config } from "../config/env.js";
import { logger } from "../config/logger.js";
import { authIdentities, localCredentials, users } from "../db/schema.js";
import { db, pool } from "../db/connection.js";
import { ensureDatabaseAndTables } from "../db/migrate.js";
import { mapInternalRole } from "../auth/abilities.js";

function requiredEnv(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} is required for first-admin bootstrap.`);
  return value;
}

async function bootstrapAdmin() {
  const email = requiredEnv("BOOTSTRAP_ADMIN_EMAIL").toLowerCase();
  const name = requiredEnv("BOOTSTRAP_ADMIN_NAME");
  const password = requiredEnv("BOOTSTRAP_ADMIN_PASSWORD");
  const sessionSecret = requiredEnv("AUTH_SESSION_SECRET");
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email))
    throw new Error("BOOTSTRAP_ADMIN_EMAIL must be a valid email address.");
  if (name.length < 2 || name.length > 120)
    throw new Error("BOOTSTRAP_ADMIN_NAME must contain 2 to 120 characters.");
  if (password.length < 16 || password.length > 128)
    throw new Error(
      "BOOTSTRAP_ADMIN_PASSWORD must contain 16 to 128 characters.",
    );
  if (sessionSecret.length < 32)
    throw new Error("AUTH_SESSION_SECRET must contain at least 32 characters.");
  if (!config.sessionSecret || config.sessionSecret !== sessionSecret)
    throw new Error(
      "AUTH_SESSION_SECRET must be available to the backend configuration.",
    );

  await ensureDatabaseAndTables();
  const passwordHash = await argon2.hash(password, { type: argon2.argon2id });
  await db.transaction(async (transaction) => {
    await transaction.execute(sql`SELECT pg_advisory_xact_lock(845215901245)`);
    const linkedAccounts = await transaction
      .select({ role: users.role })
      .from(authIdentities)
      .innerJoin(users, eq(authIdentities.userId, users.id))
      .where(eq(users.status, "active"));
    if (
      linkedAccounts.some(
        (account) => mapInternalRole(account.role) === "admin",
      )
    ) {
      throw new Error(
        "An active administrator identity already exists; bootstrap is one-time only.",
      );
    }

    const [existingUser] = await transaction
      .select()
      .from(users)
      .where(eq(users.email, email));
    let user = existingUser;
    if (user) {
      if (user.status !== "active" || mapInternalRole(user.role) !== "admin") {
        throw new Error(
          "The specified email belongs to a user who is not an active administrator.",
        );
      }
    } else {
      [user] = await transaction
        .insert(users)
        .values({
          name,
          email,
          role: "admin",
          department: "Administration",
          status: "active",
        })
        .returning();
    }

    await transaction
      .insert(localCredentials)
      .values({ userId: user.id, passwordHash });
    await transaction
      .insert(authIdentities)
      .values({
        provider: "local",
        issuer: "",
        subject: email,
        userId: user.id,
      });
  });
  logger.info(
    "Initial Fleet administrator created. Remove BOOTSTRAP_ADMIN_* values from the environment.",
  );
}

void bootstrapAdmin()
  .catch((error: unknown) => {
    logger.error(
      {
        error:
          error instanceof Error ? error.message : "Unknown bootstrap error",
      },
      "Initial administrator bootstrap failed",
    );
    process.exitCode = 1;
  })
  .finally(async () => {
    await pool.end();
  });
