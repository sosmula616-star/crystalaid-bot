import { spawn } from 'node:child_process';
import { createServer } from 'node:net';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { staffMembers, withTestDb } from './db/index.js';
import { GUILD, SUPPORT_ROLE, clearOwnedKeys, config, discordId, testRedis } from './test-helpers.js';

const control = testRedis();
beforeEach(() => clearOwnedKeys(control));
afterAll(() => control.quit());

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address() as { port: number };
      server.close(() => resolve(port));
    });
  });
}

async function until<T>(check: () => Promise<T | undefined | false>, what: string): Promise<T> {
  const deadline = Date.now() + 30_000;
  for (;;) {
    try {
      const value = await check();
      if (value) return value;
    } catch {
      // not ready yet
    }
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 100));
  }
}

describe('src/index.ts', () => {
  it('starts as one process: migrates, serves /health, consumes events, retries the failing login', () =>
    withTestDb(async (db) => {
      const port = await freePort();
      const child = spawn(process.execPath, ['--import', 'tsx', 'src/index.ts'], {
        cwd: new URL('..', import.meta.url),
        env: {
          ...process.env,
          DISCORD_BOT_TOKEN: 'dummy-token-for-the-smoke-test',
          DISCORD_CLIENT_ID: '300000000000000001',
          DATABASE_URL: process.env.TEST_DATABASE_URL,
          REDIS_URL: process.env.TEST_REDIS_URL,
          CONFIG_JSON: JSON.stringify(config),
          PORT: String(port),
        },
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      let output = '';
      child.stdout.on('data', (d: Buffer) => (output += d.toString()));
      child.stderr.on('data', (d: Buffer) => (output += d.toString()));
      const exited = new Promise<number | null>((resolve) => child.once('exit', (code) => resolve(code)));

      try {
        const health = await until(async () => {
          const res = await fetch(`http://127.0.0.1:${port}/health`);
          return res.ok ? ((await res.json()) as { status: string }) : undefined;
        }, '/health');
        expect(health).toEqual({ status: 'ok' });

        await control.xadd(
          'events:bot',
          '*',
          'event',
          JSON.stringify({
            type: 'member.updated',
            guildId: GUILD,
            userId: discordId(1),
            username: 'smoke',
            avatar: null,
            roleIds: [SUPPORT_ROLE],
            at: new Date().toISOString(),
          }),
        );
        await until(async () => (await db.select().from(staffMembers)).length === 1, 'the consumer to apply the event');
        await until(async () => output.includes('bot login failed'), 'the login failure');

        for (const stage of ['migrations applied', 'internal api', 'health listener', 'event consumer', 'bot login loop']) {
          expect(output).toContain(`stage started: ${stage}`);
        }
        expect(output).not.toContain('dummy-token-for-the-smoke-test');
      } finally {
        child.kill();
        await exited;
      }
    }), 90_000);
});
