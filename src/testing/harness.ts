import { Writable } from 'node:stream';
import type { FastifyInstance } from 'fastify';
import type { Redis } from 'ioredis';
import { withTestDb, type Db } from '../db/index.js';
import { buildServer } from '../http/server.js';
import { SERVICE_TOKEN, config } from '../test-helpers.js';

export interface AppContext {
  app: FastifyInstance;
  db: Db;
  /** Everything the server logged, as one string per line. */
  logs: string[];
}

export interface AppOptions {
  redis: Redis;
  /** Runs before the server is ready, to add test routes. */
  setup?: (app: FastifyInstance) => void;
}

/** The internal API wired to the test database and a log capture. */
export function withApp(options: AppOptions, fn: (ctx: AppContext) => Promise<void>): Promise<void> {
  return withTestDb(async (db) => {
    const logs: string[] = [];
    const logStream = new Writable({
      write(chunk: Buffer, _enc, cb) {
        logs.push(chunk.toString());
        cb();
      },
    });
    const app = await buildServer({ serviceToken: SERVICE_TOKEN, config, db, redis: options.redis, logStream });
    options.setup?.(app);
    try {
      await fn({ app, db, logs });
    } finally {
      await app.close();
    }
  });
}
