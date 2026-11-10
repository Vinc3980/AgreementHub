/**
 * API entry point: load config, verify DB connectivity, start listening.
 */
import { loadConfig } from './config.js';
import { buildApp } from './app.js';
import { startScheduler } from './services/scheduler.js';

async function main(): Promise<void> {
  const config = loadConfig();
  const app = await buildApp({ config });

  try {
    await app.ahDb.query('SELECT 1');
    app.log.info('database connection ok');
  } catch (err) {
    app.log.error({ err }, 'database unreachable');
    process.exit(1);
  }

  // Background jobs: expiry transitions, reminders, email-outbox delivery.
  // Interval 0 disables the timer (tests call the sweep functions directly).
  const stopScheduler = startScheduler(app.ahDb, config, (err) => {
    app.log.error({ err }, 'scheduler tick failed');
  });

  const shutdown = async (signal: string): Promise<void> => {
    app.log.info({ signal }, 'shutting down');
    stopScheduler();
    await app.close();
    process.exit(0);
  };
  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('SIGTERM', () => void shutdown('SIGTERM'));

  await app.listen({ port: config.PORT, host: config.HOST });
  app.log.info(`AgreementHub API listening on http://${config.HOST}:${config.PORT}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
