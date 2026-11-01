import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';

const snowflake = z.string().regex(/^\d{17,20}$/, 'must be a Discord snowflake id');
const roleList = z.array(snowflake).min(1, 'must contain at least one role id');

function isValidTimezone(tz: string): boolean {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

const serverSchema = z
  .object({
    guildId: snowflake,
    timezone: z.string().refine(isValidTimezone, 'must be a valid IANA timezone'),
    roles: z.object({
      support: roleList,
      curator: roleList,
      admin: z.array(snowflake).default([]),
    }),
    users: z
      .object({
        admins: z.array(snowflake).default([]),
        developers: z.array(snowflake).default([]),
      })
      .default({ admins: [], developers: [] }),
    channels: z.object({
      /** Log channel; may be on another server where the bot can write. */
      log: snowflake,
      /** The only channel where `/help` opens a ticket. */
      help: snowflake,
      ticketCategory: snowflake.optional(),
      ticketPanel: snowflake.optional(),
      reports: snowflake.optional(),
      audit: snowflake.optional(),
    }),
  })
  .superRefine((cfg, ctx) => {
    const seen = new Set<string>();
    for (const list of [cfg.roles.support, cfg.roles.curator, cfg.roles.admin]) {
      for (const id of new Set(list)) {
        if (seen.has(id)) {
          ctx.addIssue({
            code: 'custom',
            path: ['roles'],
            message: 'the same role id must not appear in more than one list',
          });
          return;
        }
        seen.add(id);
      }
    }
  });

export type ServerConfig = z.infer<typeof serverSchema>;

const defaultPath = fileURLToPath(new URL('../config.json', import.meta.url));

/** Validates a parsed config object. Errors name fields and rules only. */
export function parseServerConfig(raw: unknown, source: string): ServerConfig {
  const result = serverSchema.safeParse(raw);
  if (!result.success) {
    const problems = result.error.issues
      .map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`)
      .join('; ');
    throw new Error(`Invalid server config ${source}: ${problems}`);
  }
  return result.data;
}

/**
 * The server config: `CONFIG_JSON` (a one-line JSON string) when set, otherwise `config.json` in
 * the repository root (or `path`). Errors name the source and the fields, never the content.
 */
export function loadServerConfig(
  path: string = defaultPath,
  source: Record<string, string | undefined> = process.env,
): ServerConfig {
  const inline = source.CONFIG_JSON?.trim();
  if (inline) {
    let raw: unknown;
    try {
      raw = JSON.parse(inline);
    } catch {
      throw new Error('CONFIG_JSON is not valid JSON');
    }
    return parseServerConfig(raw, 'CONFIG_JSON');
  }
  let text: string;
  try {
    text = readFileSync(path, 'utf8');
  } catch {
    throw new Error(`No server config: set CONFIG_JSON or create the file ${path}`);
  }
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    throw new Error(`Server config file ${path} is not valid JSON`);
  }
  return parseServerConfig(raw, path);
}

const envSchema = z.object({
  DISCORD_BOT_TOKEN: z.string().min(1),
  DISCORD_CLIENT_ID: z.string().min(1),
  DATABASE_URL: z.string().min(1),
  /** When unset, a local redis-server is started. */
  REDIS_URL: z.string().min(1).optional(),
  /** The public port; only `GET /health` listens there. */
  PORT: z.coerce.number().int().min(1).max(65535).default(3000),
});

export type Env = z.infer<typeof envSchema>;

/** Parses the environment. Errors list variable names and rules, never values. */
export function loadEnv(source: Record<string, string | undefined> = process.env): Env {
  // An empty value counts as unset (hosts often pass blank variables).
  const cleaned = Object.fromEntries(Object.entries(source).filter(([, v]) => v !== undefined && v !== ''));
  const result = envSchema.safeParse(cleaned);
  if (!result.success) {
    const problems = result.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ');
    throw new Error(`Invalid environment configuration: ${problems}`);
  }
  return result.data;
}
