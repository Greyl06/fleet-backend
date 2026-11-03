import "./instrumentation.js";
import type { Server } from "node:http";
import { app } from "./app.js";
import { config } from "./config/env.js";
import { logger } from "./config/logger.js";
import { ensureDatabaseAndTables } from "./db/migrate.js";
import { pool, testDbConnection } from "./db/connection.js";
import { scheduleAuthRecordCleanup } from "./db/retention.js";
import { telemetrySdk } from "./instrumentation.js";

let server: Server | undefined;
let retentionTimer: NodeJS.Timeout | undefined;
let shuttingDown = false;

async function bootstrap(): Promise<void> {
  logger.info("[Bootstrap] Initializing Hulma Fleet Logistics & Maintenance API");

  if (!(await testDbConnection())) {
    throw new Error("PostgreSQL is unavailable; refusing to start API.");
  }
  await ensureDatabaseAndTables();

  const httpServer = app.listen(config.port);
  server = httpServer;
  httpServer.requestTimeout = config.requestTimeoutMs;
  httpServer.headersTimeout = config.requestTimeoutMs + 5000;
  httpServer.keepAliveTimeout = 5000;
  await new Promise<void>((resolve, reject) => {
    httpServer.once("listening", () => {
      logger.info(
        { port: config.port },
        "[Bootstrap] Fleet API is accepting requests",
      );
      resolve();
    });
    httpServer.once("error", reject);
  });
  retentionTimer = scheduleAuthRecordCleanup();
}

async function shutdown(signal: NodeJS.Signals): Promise<void> {
  if (shuttingDown) return;
  shuttingDown = true;
  logger.info({ signal }, "[Shutdown] Draining API and closing dependencies");
  if (retentionTimer) clearInterval(retentionTimer);

  const forceTimer = setTimeout(() => {
    logger.fatal("[Shutdown] Grace period exceeded; closing remaining connections");
    server?.closeAllConnections();
    process.exit(1);
  }, 10_000);
  forceTimer.unref();

  try {
    const activeServer = server;
    if (activeServer) {
      await new Promise<void>((resolve, reject) => {
        activeServer.close((error) => (error ? reject(error) : resolve()));
      });
    }
    await pool.end();
    await telemetrySdk.shutdown();
    clearTimeout(forceTimer);
    logger.info("[Shutdown] API shutdown completed");
  } catch (error) {
    logger.error({ error }, "[Shutdown] Failed to close API dependencies");
    process.exitCode = 1;
  }
}

process.once("SIGTERM", () => void shutdown("SIGTERM"));
process.once("SIGINT", () => void shutdown("SIGINT"));

bootstrap().catch(async (error: unknown) => {
  logger.fatal({ error }, "[Bootstrap] API startup failed");
  try {
    await pool.end();
    await telemetrySdk.shutdown();
  } catch (shutdownError) {
    logger.error({ error: shutdownError }, "[Bootstrap] Cleanup failed");
  }
  process.exitCode = 1;
});

// Hot-reload verification test
