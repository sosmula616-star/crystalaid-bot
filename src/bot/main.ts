import type { Redis } from 'ioredis';
import { Events } from 'discord.js';
import type { ServerConfig } from '../config.js';
import type { Logger } from '../log.js';
import { ApiClient } from './api.js';
import { assertLogChannel, createClient, createDiscordPort, guildSource, wire, wireResync } from './discord.js';
import { createHandlers } from './handlers.js';
import { createMenu } from './menu.js';
import { createRoster, createSnapshotRunner, snapshotWithRetry } from './roster.js';
import { createScheduler } from './scheduler.js';
import { redisEventSink, redisOfferStore } from './store.js';

export const LOGIN_BACKOFF_MIN_MS = 1000;
export const LOGIN_BACKOFF_MAX_MS = 30_000;

/** Next wait after a failed login: doubles from 1 second up to 30 seconds. */
export const nextBackoff = (ms: number): number => Math.min(ms * 2, LOGIN_BACKOFF_MAX_MS);

export interface BotDeps {
  token: string;
  config: ServerConfig;
  /** Base URL and token of the internal API in this process. */
  apiUrl: string;
  serviceToken: string;
  /** The bot's own Redis connection (events out, offers). The caller closes it. */
  redis: Redis;
  log: Logger;
  /** The bot cannot work at all (for example the log channel is unusable). */
  onFatal: (err: unknown) => void;
}

export interface Bot {
  /** Resolves when the login loop has ended (logged in once, or stopped). */
  loginLoop: Promise<void>;
  /** Stops the schedulers and the gateway client. Idempotent. */
  stop(): Promise<void>;
}

const message = (err: unknown) => (err instanceof Error ? `${err.name}: ${err.message}` : String(err));

/** Wires the bot and starts logging in. A failing login is retried with backoff until stopped. */
export function startBot(deps: BotDeps): Bot {
  const { config, log, redis } = deps;
  const onError = (err: unknown, where: string) => log.error(`bot: ${where}`, { error: message(err) });

  const roster = createRoster(config, redisEventSink(redis));
  const client = createClient(config, roster.isRelevant);
  const api = new ApiClient(deps.apiUrl, deps.serviceToken);
  const handlers = createHandlers({
    api,
    discord: createDiscordPort(client, config),
    store: redisOfferStore(redis),
    config,
    onError,
  });
  const scheduler = createScheduler({ api, handlers, config, onError });
  const menu = createMenu({
    api,
    config,
    onError,
    tickets: { close: handlers.adminClose, release: handlers.adminRelease },
    botUptimeSeconds: () => Math.floor(process.uptime()),
  });
  wire(client, handlers, roster, onError, menu, config);

  // The roster snapshot is the base the API builds on; it runs at startup, after a lost session and
  // once a day, with retries (the gateway limits member requests).
  const source = guildSource(client, config.guildId, onError);
  const snapshots = createSnapshotRunner({
    run: () =>
      snapshotWithRetry(roster, source, {
        onFail: (err, attempt) => onError(err, `roster snapshot (attempt ${attempt})`),
      }),
    onDone: (n, reason) => log.info('roster snapshot published', { members: n, reason }),
    onFail: (err, reason) => {
      onError(err, `roster snapshot (${reason}), giving up until the next run`);
      void handlers.log(
        'Не удалось отправить список участников ветки. Проверьте интент Server Members и повторите запуск, иначе роли не обновятся.',
      );
    },
  });
  let ready = false;
  wireResync(client, snapshots, () => ready);

  client.once(Events.ClientReady, () => {
    log.info('bot logged in', { tag: client.user?.tag });
    assertLogChannel(client, config).then(() => {
      ready = true;
      snapshots.trigger('startup');
      snapshots.start();
      scheduler.start();
    }, deps.onFatal);
  });

  let stopping = false;
  let wake: () => void = () => {};
  const pause = (ms: number) =>
    new Promise<void>((resolve) => {
      const timer = setTimeout(resolve, ms);
      wake = () => {
        clearTimeout(timer);
        resolve();
      };
    });

  const loginLoop = (async () => {
    let backoff = LOGIN_BACKOFF_MIN_MS;
    while (!stopping) {
      try {
        await client.login(deps.token);
        return;
      } catch (err) {
        if (stopping) return;
        log.error('bot login failed, will retry', { error: message(err), retryInMs: backoff });
        try {
          await client.destroy();
        } catch {
          // the client may not have been connected at all
        }
        await pause(backoff);
        backoff = nextBackoff(backoff);
      }
    }
  })();

  let stopped: Promise<void> | undefined;
  return {
    loginLoop,
    stop() {
      stopped ??= (async () => {
        stopping = true;
        wake();
        scheduler.stop();
        snapshots.stop();
        await loginLoop.catch(() => {});
        await client.destroy();
      })();
      return stopped;
    },
  };
}
