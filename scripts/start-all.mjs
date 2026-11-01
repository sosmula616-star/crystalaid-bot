#!/usr/bin/env node
// One-container launcher (bothost.tech): bot + worker + API (which also serves the Activity).
// Plain Node, no dependencies. Stages, in order:
//   config      CONFIG_JSON -> private temp file + CONFIG_PATH, validated with the server-config schema
//   secrets     SERVICE_TOKEN and JWT_SECRET are generated when unset; the Discord values and DATABASE_URL are required
//   redis       REDIS_URL unset -> bundled redis-server on 127.0.0.1, no persistence
//   migrate     once
//   commands    Discord command registration (failure is logged, not fatal)
//   run         API, worker and bot, each restarted with backoff 1 -> 30 s
// Child output is filtered: connection strings and the values of secret variables never reach the log.
import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { connect, createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';

const root = resolve(fileURLToPath(new URL('..', import.meta.url)));
const tsx = join(root, 'apps/api/node_modules/tsx/dist/cli.mjs');

const STOP_GRACE_MS = 8000; // the whole shutdown stays under 10 s
const BACKOFF_START_MS = 1000;
const BACKOFF_MAX_MS = 30000;
const HEALTHY_AFTER_MS = 60000;

const SECRET_NAMES = [
  'DATABASE_URL',
  'REDIS_URL',
  'DISCORD_CLIENT_SECRET',
  'DISCORD_BOT_TOKEN',
  'JWT_SECRET',
  'SERVICE_TOKEN',
  'CONFIG_JSON',
];
const URL_LIKE = /[a-z][a-z0-9+.-]*:\/\/[^\s'"<>)]+/gi;

const log = (message) => console.log(`[launcher] ${message}`);

/** Replaces connection strings and the exact values of secret variables. */
function scrub(line) {
  let out = line.replace(URL_LIKE, '[url]');
  for (const name of SECRET_NAMES) {
    const value = process.env[name];
    if (value && value.length >= 8) out = out.split(value).join('[redacted]');
  }
  return out;
}

let stopping = false;
const children = new Set();
let tempDir;

/** Starts a process; `tag` prefixes its (scrubbed) output lines. */
function start(tag, command, args) {
  const child = spawn(command, args, { cwd: root, env: process.env, stdio: ['ignore', 'pipe', 'pipe'] });
  children.add(child);
  for (const [stream, sink] of [
    [child.stdout, process.stdout],
    [child.stderr, process.stderr],
  ]) {
    createInterface({ input: stream }).on('line', (line) => sink.write(`[${tag}] ${scrub(line)}\n`));
  }
  const done = new Promise((resolveDone) => {
    child.once('error', (err) => {
      log(`cannot start ${tag}: ${err.code ?? err.name}`);
      children.delete(child);
      resolveDone({ code: 127, signal: null });
    });
    child.once('exit', (code, signal) => {
      children.delete(child);
      resolveDone({ code, signal });
    });
  });
  return { child, done };
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Sleeps, but wakes early when the launcher is stopping. */
async function pause(ms) {
  for (let waited = 0; waited < ms && !stopping; waited += 200) await sleep(200);
}

function fail(message) {
  console.error(`[launcher] ${message}`);
  cleanup();
  process.exit(1);
}

/** Runs a one-shot tsx step to completion; resolves with its exit code. */
async function runOnce(tag, args) {
  const { code } = await start(tag, process.execPath, [tsx, ...args]).done;
  return code;
}

function freePort() {
  return new Promise((resolvePort, reject) => {
    const server = createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      server.close(() => resolvePort(port));
    });
  });
}

function redisAnswers(port) {
  return new Promise((resolveOk) => {
    const socket = connect({ host: '127.0.0.1', port });
    const finish = (ok) => {
      socket.destroy();
      resolveOk(ok);
    };
    socket.setTimeout(500, () => finish(false));
    socket.once('error', () => finish(false));
    socket.once('connect', () => socket.write('PING\r\n'));
    socket.once('data', (data) => finish(data.toString().startsWith('+PONG')));
  });
}

/** Restarts `run()` with backoff until the launcher stops. `run` resolves with a reason. */
function supervise(name, run) {
  void (async () => {
    let backoff = BACKOFF_START_MS;
    while (!stopping) {
      const startedAt = Date.now();
      const reason = await run();
      if (stopping) return;
      backoff = Date.now() - startedAt > HEALTHY_AFTER_MS ? BACKOFF_START_MS : Math.min(backoff * 2, BACKOFF_MAX_MS);
      log(`${name} ${reason}; restarting in ${backoff / 1000}s`);
      await pause(backoff);
    }
  })();
}

function cleanup() {
  if (tempDir) rmSync(tempDir, { recursive: true, force: true });
  tempDir = undefined;
}

async function stopAll() {
  if (stopping) return;
  stopping = true;
  log('stopping');
  const running = [...children];
  for (const child of running) child.kill('SIGTERM');
  const exited = Promise.all(
    running.map((c) => new Promise((r) => (c.exitCode !== null || c.signalCode ? r() : c.once('exit', r)))),
  );
  const timedOut = await Promise.race([exited.then(() => false), sleep(STOP_GRACE_MS).then(() => true)]);
  if (timedOut) {
    log('children did not stop in time; killing');
    for (const child of children) child.kill('SIGKILL');
    await sleep(300);
  }
  cleanup();
  process.exit(0);
}

async function main() {
  process.on('SIGTERM', () => void stopAll());
  process.on('SIGINT', () => void stopAll());
  process.on('exit', cleanup);

  // 1. config
  if (process.env.CONFIG_JSON) {
    try {
      tempDir = mkdtempSync(join(tmpdir(), `crystalaid-${randomBytes(4).toString('hex')}-`));
      const file = join(tempDir, 'config.json');
      writeFileSync(file, process.env.CONFIG_JSON, { mode: 0o600 });
      process.env.CONFIG_PATH = file;
    } catch (err) {
      fail(`cannot write the config file: ${err.code ?? err.name}`);
    }
    log('server config written to a temporary file');
  } else if (!process.env.CONFIG_PATH) {
    log('no CONFIG_JSON or CONFIG_PATH: using crystalaid.config.json in the repository root');
  }
  if ((await runOnce('config', [join(root, 'scripts/validate-config.ts')])) !== 0) {
    fail('the server config is invalid (the field is named above)');
  }
  log('server config is valid');

  // 2. secrets
  for (const name of ['DISCORD_CLIENT_SECRET', 'DISCORD_BOT_TOKEN', 'DISCORD_CLIENT_ID', 'DATABASE_URL']) {
    if (!process.env[name]) fail(`required variable ${name} is not set`);
  }
  for (const name of ['SERVICE_TOKEN', 'JWT_SECRET']) {
    if (!process.env[name]) {
      process.env[name] = randomBytes(32).toString('hex');
      log(`${name} is not set: a generated value is used (a restart issues a new one)`);
    }
  }

  // 3. redis
  if (!process.env.REDIS_URL) {
    const redisPort = await freePort();
    process.env.REDIS_URL = `redis://127.0.0.1:${redisPort}`;
    supervise('redis-server', async () => {
      const { code } = await start('redis', 'redis-server', [
        '--bind', '127.0.0.1',
        '--port', String(redisPort),
        '--save', '',
        '--appendonly', 'no',
        '--protected-mode', 'yes',
      ]).done;
      if (code === 127 && !stopping) fail('redis-server is not installed: set REDIS_URL or install redis-server');
      return `exited (${code})`;
    });
    let up = false;
    for (let i = 0; i < 100 && !stopping && !up; i++) {
      up = await redisAnswers(redisPort);
      if (!up) await sleep(100);
    }
    if (!up) fail('the bundled redis-server did not answer PING');
    log('bundled Redis is up on 127.0.0.1 (no persistence)');
  }

  // 4. migrations
  if ((await runOnce('migrate', ['packages/database/src/migrate.ts'])) !== 0) fail('migrations failed');
  log('migrations done');

  // 5. addresses
  const port = process.env.PORT || '3000';
  process.env.PORT = port;
  process.env.ACTIVITY_DIST ||= join(root, 'apps/activity/dist');
  process.env.API_URL = `http://127.0.0.1:${port}`;

  // 6. commands
  const registered = await runOnce('commands', ['apps/bot/src/main.ts', 'register']);
  log(registered === 0 ? 'Discord commands registered' : `Discord command registration failed (${registered}); continuing`);

  // 7. run
  const roles = [
    ['api', ['apps/api/src/main.ts', 'api']],
    ['worker', ['apps/api/src/main.ts', 'worker']],
    ['bot', ['apps/bot/src/main.ts', 'start']],
  ];
  for (const [name, args] of roles) {
    supervise(name, async () => {
      log(`starting ${name}`);
      const { code, signal } = await start(name, process.execPath, [tsx, ...args]).done;
      return `exited (${code ?? signal})`;
    });
  }
  log(`all services started; the API listens on 0.0.0.0:${port}`);
}

main().catch((err) => fail(`fatal: ${scrub(String(err?.message ?? err))}`));
