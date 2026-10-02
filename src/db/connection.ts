import pg from 'pg';
import { drizzle } from 'drizzle-orm/node-postgres';
import * as schema from './schema.js';
import { config } from '../config/env.js';
import { logger } from '../config/logger.js';

const { Pool } = pg;

export const pool = new Pool({
  connectionString: config.databaseUrl,
  max: 10,
  idleTimeoutMillis: 30000,
  connectionTimeoutMillis: 5000,
});

pool.on('error', (err) => {
  logger.error({ err }, '[PostgreSQL] Unexpected error on idle client');
});

export const db = drizzle(pool, { schema });

export async function testDbConnection(): Promise<boolean> {
  try {
    const client = await pool.connect();
    await client.query('SELECT 1');
    client.release();
    logger.info('[PostgreSQL] Connected successfully to database');
    return true;
  } catch (err: unknown) {
    const error = err as Error;
    logger.warn({ error: error.message }, '[PostgreSQL] Could not connect to database on startup. Operating in standby mode.');
    return false;
  }
}
