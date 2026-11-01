// Run by scripts/start-all.mjs: validates the server config at CONFIG_PATH with the real schema.
// A failure names the bad field (and never prints a value).
import { loadServerConfig } from '../packages/config/src/index.js';

try {
  loadServerConfig(process.env.CONFIG_PATH || undefined);
} catch (err) {
  console.error(err instanceof Error ? err.message : 'invalid server config');
  process.exit(1);
}
