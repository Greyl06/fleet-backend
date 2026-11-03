import pg from 'pg';
import { drizzle } from 'drizzle-orm/node-postgres';
import * as schema from './schema.js';
import { config } from '../config/env.js';
import { logger } from '../config/logger.js';

const { Pool } = pg;

export const pool = new Pool({
  connectionString: config.databaseUrl,
  max: config.dbPoolMax,
  idleTimeoutMillis: 30000,
  connectionTimeoutMillis: 5000,
  query_timeout: 15000,
  statement_timeout: 15000,
  idle_in_transaction_session_timeout: 30000,
  keepAlive: true,
});

pool.on('error', (err) => {
  logger.error({ err }, '[PostgreSQL] Unexpected error on idle client');
});

export const db = drizzle(pool, { schema });

export async function testDbConnection(): Promise<boolean> {
  let client: pg.PoolClient | undefined;
  try {
    client = await pool.connect();
    await client.query('SELECT 1');
    logger.info('[PostgreSQL] Connected successfully to database');
    return true;
  } catch (err: unknown) {
    const error = err as Error;
    logger.warn({ error: error.message }, '[PostgreSQL] Could not connect during startup.');
    return false;
  } finally {
    client?.release();
  }
}

export async function checkDatabaseReadiness(): Promise<void> {
  await pool.query('SELECT 1');
}
