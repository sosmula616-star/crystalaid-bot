import { randomBytes } from 'node:crypto';
import { hostname } from 'node:os';
import { Redis } from 'ioredis';
import { loadEnv, loadServerConfig } from './config.js';
import { createDb, runMigrations } from './db/index.js';
import { registerCommands } from './bot/commands.js';
import { startBot } from './bot/main.js';
import { closeServer, startHealthServer } from './http/health.js';
import { buildServer } from './http/server.js';
import { consoleLog as log } from './log.js';
import { ensureSeeded } from './services/permissions.js';
import { describeStartupError, loadRootEnvFile } from './startup.js';
import { startLocalRedis } from './worker/localRedis.js';
import { startWorker } from './worker/main.js';

const SHUTDOWN_LIMIT_MS = 10_000;
const COMMANDS_LIMIT_MS = 15_000;

const message = (err: unknown) => (err instanceof Error ? err.message : String(err));

interface Cleanup {
  name: string;
  run: () => Promise<unknown>;
}

async function main(): Promise<void> {
  // 1. .env when present; variables of the real environment win.
  const loadedEnvFile = loadRootEnvFile();
  log.info('stage started: environment', { envFile: loadedEnvFile });

  // 2. Server config (CONFIG_JSON or config.json) and required variables. Both are checked
  // before anything is started, so a mistake stops the process with one clear message.
  const config = loadServerConfig();
  const env = loadEnv();
  log.info('stage started: config', { guildId: config.guildId, timezone: config.timezone });

  const cleanups: Cleanup[] = [];
  let killLocalRedis: (() => void) | undefined;
  let stopping: Promise<void> | undefined;
  let exitCode = 0;

  /** Stops everything in reverse order of start, within SHUTDOWN_LIMIT_MS. */
  const shutdown = (reason: string, code = 0): Promise<void> => {
    stopping ??= (async () => {
      exitCode = code;
      log.info('shutting down', { reason });
      const hard = setTimeout(() => {
        log.error('shutdown took too long, exiting', { limitMs: SHUTDOWN_LIMIT_MS });
        killLocalRedis?.();
        process.exit(1);
      }, SHUTDOWN_LIMIT_MS);
      hard.unref();
      for (const step of [...cleanups].reverse()) {
        try {
          await step.run();
        } catch (err) {
          log.error('shutdown step failed', { step: step.name, error: message(err) });
        }
      }
      clearTimeout(hard);
      log.info('stopped');
    })();
    return stopping;
  };

  try {
    // 3. Redis: REDIS_URL, or a private local redis-server.
    let redisUrl = env.REDIS_URL;
    if (!redisUrl) {
      const local = await startLocalRedis();
      redisUrl = local.url;
      killLocalRedis = local.killNow;
      cleanups.push({ name: 'local redis', run: () => local.stop() });
      log.info('stage started: local redis-server', { host: '127.0.0.1' });
    } else {
      log.info('stage started: redis', { source: 'REDIS_URL' });
    }
    const url = redisUrl;

    // 4. Migrations.
    await runMigrations(env.DATABASE_URL);
    log.info('stage started: migrations applied');

    // 5. Internal API on a free local port, with a token that exists only in this process.
    const db = createDb(env.DATABASE_URL, (err) => log.error('database pool error', { error: err.message }));
    const apiRedis = new Redis(url, { maxRetriesPerRequest: 1, connectTimeout: 500 });
    apiRedis.on('error', (err) => log.error('redis error', { client: 'api', error: err.message }));
    const workerRedis = new Redis(url);
    workerRedis.on('error', (err) => log.error('redis error', { client: 'worker', error: err.message }));
    const botRedis = new Redis(url);
    botRedis.on('error', (err) => log.error('redis error', { client: 'bot', error: err.message }));
    // Closed late: the worker ends the pool and its own Redis connection.
    cleanups.push({ name: 'redis connections', run: () => Promise.allSettled([apiRedis.quit(), botRedis.quit()]) });

    await ensureSeeded(db, config.guildId);
    const serviceToken = randomBytes(32).toString('hex');
    const app = await buildServer({ serviceToken, config, db, redis: apiRedis });
    await app.listen({ port: 0, host: '127.0.0.1' });
    const apiPort = (app.server.address() as { port: number }).port;
    const apiUrl = `http://127.0.0.1:${apiPort}`;
    cleanups.push({ name: 'internal api', run: () => app.close() });
    log.info('stage started: internal api', { host: '127.0.0.1', port: apiPort });

    const health = await startHealthServer(env.PORT);
    cleanups.push({ name: 'health listener', run: () => closeServer(health) });
    log.info('stage started: health listener', { host: '0.0.0.0', port: env.PORT });

    // 6. Event consumer, in this process.
    const consumer = `${hostname()}-${process.pid}`;
    const worker = startWorker({ db, redis: workerRedis, config, log, consumer });
    cleanups.push({ name: 'event consumer', run: () => worker.stopWorker() });
    log.info('stage started: event consumer', { consumer });

    // 7. Slash commands; a failure is logged and does not stop the bot.
    try {
      let timer: NodeJS.Timeout | undefined;
      const limit = new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error('timed out')), COMMANDS_LIMIT_MS);
      });
      const count = await Promise.race([
        registerCommands(env.DISCORD_BOT_TOKEN, env.DISCORD_CLIENT_ID, config.guildId),
        limit,
      ]).finally(() => clearTimeout(timer));
      log.info('stage started: commands registered', { count });
    } catch (err) {
      log.error('commands were not registered', { error: message(err) });
    }

    // 8. The bot logs in; a failing login is retried with backoff from 1 to 30 seconds.
    const bot = startBot({
      token: env.DISCORD_BOT_TOKEN,
      config,
      apiUrl,
      serviceToken,
      redis: botRedis,
      log,
      onFatal: (err) => {
        log.error('bot cannot work, stopping', { error: message(err) });
        void shutdown('fatal bot error', 1).then(() => process.exit(exitCode));
      },
    });
    cleanups.push({ name: 'bot', run: () => bot.stop() });
    log.info('stage started: bot login loop');

    // 9. Signals.
    const onSignal = (signal: string) => void shutdown(signal).then(() => process.exit(exitCode));
    process.once('SIGTERM', () => onSignal('SIGTERM'));
    process.once('SIGINT', () => onSignal('SIGINT'));
    process.on('unhandledRejection', (err) => log.error('unhandled rejection', { error: message(err) }));
  } catch (err) {
    // A stage failed: undo what was started (above all the local redis-server), then report.
    await shutdown('startup failed', 1);
    throw err;
  }
}

main().catch((err: unknown) => {
  for (const line of describeStartupError(err)) console.error(line);
  process.exit(1);
});
