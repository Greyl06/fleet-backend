import { pool } from "./connection.js";
import { logger } from "../config/logger.js";

const RETENTION_DAYS = 90;
const BATCH_SIZE = 5000;
const MAX_BATCHES_PER_TABLE = 5;
const CLEANUP_INTERVAL_MS = 60 * 60 * 1000;

const cleanupStatements = [
  {
    table: "auth_sessions",
    query: `
      WITH expired AS (
        SELECT id
        FROM auth_sessions
        WHERE expires_at < $1 OR revoked_at < $1
        ORDER BY expires_at, id
        LIMIT $2
        FOR UPDATE SKIP LOCKED
      )
      DELETE FROM auth_sessions AS records
      USING expired
      WHERE records.id = expired.id
    `,
  },
  {
    table: "password_reset_tokens",
    query: `
      WITH expired AS (
        SELECT id
        FROM password_reset_tokens
        WHERE expires_at < $1 OR consumed_at < $1
        ORDER BY expires_at, id
        LIMIT $2
        FOR UPDATE SKIP LOCKED
      )
      DELETE FROM password_reset_tokens AS records
      USING expired
      WHERE records.id = expired.id
    `,
  },
  {
    table: "auth_signup_requests",
    query: `
      WITH expired AS (
        SELECT id
        FROM auth_signup_requests
        WHERE status = 'pending_verification'
          AND verification_expires_at < $1
        ORDER BY verification_expires_at, id
        LIMIT $2
        FOR UPDATE SKIP LOCKED
      )
      DELETE FROM auth_signup_requests AS records
      USING expired
      WHERE records.id = expired.id
    `,
  },
] as const;

export async function cleanupExpiredAuthRecords(): Promise<Record<string, number>> {
  const cutoff = new Date(
    Date.now() - RETENTION_DAYS * 24 * 60 * 60 * 1000,
  );
  const deleted: Record<string, number> = {};

  for (const statement of cleanupStatements) {
    let tableDeleted = 0;
    for (let batch = 0; batch < MAX_BATCHES_PER_TABLE; batch += 1) {
      const result = await pool.query(statement.query, [cutoff, BATCH_SIZE]);
      const batchDeleted = result.rowCount ?? 0;
      tableDeleted += batchDeleted;
      if (batchDeleted < BATCH_SIZE) break;
    }
    deleted[statement.table] = tableDeleted;
  }

  logger.info(
    { retentionDays: RETENTION_DAYS, deleted },
    "[Retention] Expired authentication records purged in bounded batches",
  );
  return deleted;
}

export function scheduleAuthRecordCleanup(): NodeJS.Timeout {
  const runCleanup = () => {
    void cleanupExpiredAuthRecords().catch((error: unknown) => {
      logger.error({ error }, "[Retention] Authentication cleanup failed");
    });
  };

  runCleanup();
  const timer = setInterval(runCleanup, CLEANUP_INTERVAL_MS);
  timer.unref();
  return timer;
}
