import { createHash, timingSafeEqual } from 'node:crypto';
import { AppError } from '../contracts/index.js';
import type { FastifyInstance, FastifyRequest } from 'fastify';

type Guard = (request: FastifyRequest) => Promise<void>;

declare module 'fastify' {
  interface FastifyInstance {
    /** onRequest hook: `Authorization: Bearer <service token>`, for the bot in the same process. */
    requireService: Guard;
  }
}

const bearer = (request: FastifyRequest): string | undefined =>
  /^Bearer (.+)$/i.exec(request.headers.authorization ?? '')?.[1];

const digest = (value: string) => createHash('sha256').update(value).digest();

/** The only authentication of the internal API: a token generated for this process. */
export function registerServiceAuth(app: FastifyInstance, serviceToken: string): void {
  const expected = digest(serviceToken);
  app.decorate('requireService', async (request: FastifyRequest) => {
    const token = bearer(request);
    // Compare fixed-length digests so neither content nor length leaks through timing.
    if (!token || !timingSafeEqual(digest(token), expected)) {
      throw new AppError('UNAUTHORIZED', 'Invalid service token', 401);
    }
  });
}
