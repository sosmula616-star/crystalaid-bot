import { randomUUID } from 'node:crypto';
import type { Writable } from 'node:stream';
import Fastify, { type FastifyInstance } from 'fastify';
import type { Redis } from 'ioredis';
import type { ServerConfig } from '../config.js';
import type { Db } from '../db/index.js';
import { registerServiceAuth } from './auth.js';
import { registerErrorHandling } from './errors.js';
import { registerInternal } from './routes/internal.js';

export interface ServerDeps {
  /** The token the bot sends; generated at random for each process. */
  serviceToken: string;
  config: ServerConfig;
  db: Db;
  redis: Redis;
  /** Where Pino writes; stdout when omitted. Tests pass a stream to capture the log. */
  logStream?: Writable;
}

/** Builds the internal API. It is not listening yet, so routes can still be added. */
export async function buildServer(deps: ServerDeps): Promise<FastifyInstance> {
  const { db, redis } = deps;
  const app = Fastify({
    logger: {
      level: 'info',
      redact: { paths: ['req.headers.authorization', 'req.headers.cookie'], censor: '[redacted]' },
      ...(deps.logStream ? { stream: deps.logStream } : {}),
    },
    // The id comes from the server only, so a client cannot forge log correlation.
    requestIdHeader: false,
    genReqId: () => randomUUID(),
  });

  registerErrorHandling(app);
  registerServiceAuth(app, deps.serviceToken);
  registerInternal(app, { db, config: deps.config, redis });
  return app;
}
