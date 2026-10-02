import { app } from './app.js';
import { config } from './config/env.js';
import { logger } from './config/logger.js';
import { ensureDatabaseAndTables } from './db/migrate.js';
import { testDbConnection } from './db/connection.js';

async function bootstrap() {
  logger.info('[Bootstrap] Initializing Hulma Fleet Logistics & Maintenance API...');

  try {
    const isConnected = await testDbConnection();
    if (isConnected) {
      await ensureDatabaseAndTables();
    }
  } catch (err: unknown) {
    const error = err as Error;
    logger.warn({ error: error.message }, '[Bootstrap] DB init notice, continuing server launch...');
  }

  app.listen(config.port, () => {
    logger.info(`🚀 Server running on http://localhost:${config.port}`);
    logger.info(`   - Health check: http://localhost:${config.port}/api/health`);
    logger.info(`   - Vehicles API: http://localhost:${config.port}/api/vehicles`);
    logger.info(`   - TSRF API:     http://localhost:${config.port}/api/tsrf`);
    logger.info(`   - Maintenance:  http://localhost:${config.port}/api/maintenance`);
    logger.info(`   - Procurement:  http://localhost:${config.port}/api/procurement`);
  });
}

bootstrap().catch((err) => {
  logger.error(err, '[Bootstrap] Fatal startup error');
  process.exit(1);
});
