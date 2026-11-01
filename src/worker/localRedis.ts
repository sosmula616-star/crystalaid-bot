import { spawn, type ChildProcess } from 'node:child_process';
import { createServer } from 'node:net';
import { Redis } from 'ioredis';

export interface LocalRedis {
  url: string;
  /** Stops the child process; resolves when it has exited. Idempotent. */
  stop(): Promise<void>;
  /** Kills the child at once, the last resort when a graceful stop took too long. */
  killNow(): void;
}

export function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address() as { port: number };
      server.close(() => resolve(port));
    });
  });
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function waitForPing(url: string, child: ChildProcess, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (child.exitCode !== null) throw new Error(`redis-server exited with code ${child.exitCode} during startup`);
    const probe = new Redis(url, { lazyConnect: true, maxRetriesPerRequest: 0, retryStrategy: () => null, connectTimeout: 500 });
    probe.on('error', () => {});
    try {
      await probe.connect();
      if ((await probe.ping()) === 'PONG') return;
    } catch {
      // not accepting connections yet
    } finally {
      probe.disconnect();
    }
    if (Date.now() > deadline) throw new Error('redis-server did not answer PING in time');
    await sleep(100);
  }
}

/**
 * Starts a private `redis-server` on 127.0.0.1 with no persistence and waits for PING. Used when
 * REDIS_URL is not set. Throws a clear message when the binary is missing.
 */
export async function startLocalRedis(binary = 'redis-server', timeoutMs = 10_000): Promise<LocalRedis> {
  const port = await freePort();
  const child = spawn(
    binary,
    ['--bind', '127.0.0.1', '--port', String(port), '--save', '', '--appendonly', 'no', '--protected-mode', 'yes'],
    { stdio: 'ignore', windowsHide: true },
  );
  const spawnFailure = new Promise<never>((_, reject) => {
    child.once('error', (err: NodeJS.ErrnoException) => {
      reject(
        err.code === 'ENOENT'
          ? new Error(`${binary} was not found: install Redis (the redis-server program) or set REDIS_URL`)
          : new Error(`Cannot start ${binary}: ${err.message}`),
      );
    });
  });
  const url = `redis://127.0.0.1:${port}`;

  let stopped: Promise<void> | undefined;
  const stop = (): Promise<void> => {
    stopped ??= new Promise<void>((resolve) => {
      if (child.exitCode !== null || child.signalCode !== null || child.pid === undefined) return resolve();
      const force = setTimeout(() => child.kill('SIGKILL'), 3000);
      child.once('exit', () => {
        clearTimeout(force);
        resolve();
      });
      child.kill('SIGTERM');
    });
    return stopped;
  };

  try {
    await Promise.race([waitForPing(url, child, timeoutMs), spawnFailure]);
  } catch (err) {
    await stop();
    throw err;
  }
  return { url, stop, killNow: () => void child.kill('SIGKILL') };
}
