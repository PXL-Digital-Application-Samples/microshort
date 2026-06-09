import app, { logger } from './server';

const PORT = process.env.PORT || 3000;

const server = app.listen(PORT, () => {
  logger.info({ port: PORT }, 'Config service started');
});

const shutdown = async (signal: string) => {
  logger.info({ signal }, 'Shutdown signal received');
  server.close(() => {
    logger.info('Config service shut down cleanly');
    process.exit(0);
  });
  setTimeout(() => process.exit(1), 30_000).unref();
};

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT',  () => shutdown('SIGINT'));
