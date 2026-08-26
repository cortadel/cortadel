#!/usr/bin/env node
// Cortadel plugin diagnostic. Runs every check and reports all of them — it never
// stops at the first failure, because the useful signal is usually the COMBINATION
// (health ok + auth 403 means something very different from health unreachable).
//
// Unlike the hooks, this deliberately does NOT fail open: it uses apiDetailed() so
// real status codes stay visible, and exits 1 when any check fails.
//
// Why this is a script and not a prose recipe: the hooks receive their config as
// CLAUDE_PLUGIN_OPTION_* env vars injected into the hook subprocess, and those are
// NOT visible to a skill's own shell. A diagnostic that only reads the environment
// therefore reports a perfectly healthy install as "NOT SET" — so this resolves the
// same on-disk config Claude Code persisted at install time as well.
//
// Prints no secret values, ever — only whether each one resolved, and from where.

import { readFileSync, existsSync, statSync, openSync, readSync, closeSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { apiDetailed } from './lib.mjs';

const PLUGIN_PREFIX = 'cortadel-memory@';

/** Parse a JSON file, or return null (missing/unreadable/malformed all behave the same here). */
function readJson(p) {
  try {
    return existsSync(p) ? JSON.parse(readFileSync(p, 'utf8')) : null;
  } catch {
    return null;
  }
}

/**
 * Config Claude Code persisted when the plugin was installed from a marketplace:
 * non-sensitive options in the settings file's `pluginConfigs`, sensitive ones in
 * `.credentials.json`'s `pluginSecrets`, both keyed `<plugin>@<marketplace>`. The
 * marketplace half varies with how the user added it, so match on the prefix.
 */
function readInstalledConfig() {
  const home = homedir();
  const out = { options: {}, apiKey: undefined, source: null };

  for (const p of [join(home, '.claude', 'settings.json'), join(home, '.claude', 'settings.local.json')]) {
    const cfgs = readJson(p)?.pluginConfigs;
    if (!cfgs) continue;
    const key = Object.keys(cfgs).find((k) => k.startsWith(PLUGIN_PREFIX));
    if (key && cfgs[key]?.options) {
      out.options = cfgs[key].options;
      out.source = p;
      break;
    }
  }

  const secrets = readJson(join(home, '.claude', '.credentials.json'))?.pluginSecrets;
  if (secrets) {
    const key = Object.keys(secrets).find((k) => k.startsWith(PLUGIN_PREFIX));
    if (key && secrets[key]?.api_key) out.apiKey = secrets[key].api_key;
  }
  return out;
}

/**
 * Last `count` lines of a file, reading only the final 64 KiB rather than the
 * whole thing — the hook log is append-only and rotates at 5 MiB, so slurping it
 * to show 40 lines would be pointlessly expensive on a long-lived install.
 */
function tailLines(file, count, window = 64 * 1024) {
  const size = statSync(file).size;
  if (size === 0) return [];
  const start = Math.max(0, size - window);
  const buf = Buffer.alloc(Math.min(window, size));
  const fd = openSync(file, 'r');
  try {
    readSync(fd, buf, 0, buf.length, start);
  } finally {
    closeSync(fd);
  }
  let text = buf.toString('utf8');
  // Reading from an offset almost certainly lands mid-line; drop that fragment.
  if (start > 0) {
    const nl = text.indexOf('\n');
    text = nl === -1 ? '' : text.slice(nl + 1);
  }
  return text.split(/\r?\n/).filter(Boolean).slice(-count);
}

const ENV_FALLBACK = {
  base_url: 'CORTADEL_URL',
  user_id: 'CORTADEL_USER_ID',
  api_key: 'CORTADEL_API_KEY',
  client_name: 'CORTADEL_CLIENT_NAME',
};

/**
 * Resolve one option across all three tiers, reporting which one won. Same
 * precedence the hooks use (lib.mjs readOption), with the installed-config tier
 * appended underneath — it is the only tier readable from outside a hook process.
 */
function resolve(option, installed) {
  const pluginVar = `CLAUDE_PLUGIN_OPTION_${option.toUpperCase()}`;
  if (process.env[pluginVar]) return { value: process.env[pluginVar], from: pluginVar };
  const envVar = ENV_FALLBACK[option];
  if (process.env[envVar]) return { value: process.env[envVar], from: envVar };
  if (option === 'api_key' && installed.apiKey) return { value: installed.apiKey, from: '~/.claude/.credentials.json' };
  const v = installed.options?.[option];
  if (v) return { value: String(v), from: (installed.source || 'installed config').replace(homedir(), '~') };
  return { value: undefined, from: null };
}

const rows = [];
const record = (name, status, detail) => {
  rows.push({ name, status, detail });
  const icon = status === 'PASS' ? 'PASS' : status === 'WARN' ? 'WARN' : status === 'SKIP' ? 'SKIP' : 'FAIL';
  console.log(`${icon.padEnd(5)} ${name.padEnd(20)} ${detail}`);
};

const installed = readInstalledConfig();
const baseUrl = resolve('base_url', installed);
const userId = resolve('user_id', installed);
const apiKey = resolve('api_key', installed);
const clientName = resolve('client_name', installed);

// ---- Check 1: config resolution (never prints the key itself) -----------------
const missing = [
  ['base_url', baseUrl],
  ['user_id', userId],
  ['api_key', apiKey],
].filter(([, r]) => !r.value).map(([n]) => n);

if (missing.length) {
  record('Config resolution', 'FAIL', `missing: ${missing.join(', ')} — the plugin is unconfigured, all hooks are silent no-ops`);
} else {
  record(
    'Config resolution',
    'PASS',
    `base_url=${baseUrl.value} user_id=${userId.value} client_name=${clientName.value || 'claude (default)'} api_key=<resolved> ` +
      `[from ${[...new Set([baseUrl.from, userId.from, apiKey.from])].join(', ')}]`
  );
}

if (process.env.CORTADEL_HOOKS_DISABLE === '1') {
  record('Hooks enabled', 'WARN', 'CORTADEL_HOOKS_DISABLE=1 — all three hooks are intentionally disabled');
}

let failed = missing.length > 0;

if (!missing.length) {
  const config = { url: String(baseUrl.value).replace(/\/+$/, ''), apiKey: apiKey.value, userId: userId.value };

  // ---- Check 2: server health (no credentials involved) ----------------------
  const health = await apiDetailed(config, 'GET', '/api/health', { timeoutMs: 15000 });
  if (health.ok) {
    const checks = Object.entries(health.data?.checks ?? {})
      .filter(([, v]) => v && typeof v === 'object' && 'ok' in v)
      .map(([k, v]) => `${k}=${v.ok ? 'ok' : 'FAILING'}`)
      .join(' ');
    const degraded = health.data?.status !== 'ok';
    record('Server health', degraded ? 'WARN' : 'PASS', `status=${health.data?.status} ${checks}`);
    if (degraded) failed = true;
  } else {
    record('Server health', 'FAIL', `${health.error}${health.status ? ' ' + health.status : ''} at ${config.url}`);
    failed = true;
  }

  // ---- Check 3 + 4: auth and a live read (one request answers both) ----------
  const read = await apiDetailed(config, 'GET', '/api/v1/memories', {
    query: { user_id: config.userId, size: 1, page: 1 },
    timeoutMs: 20000,
  });
  if (read.ok) {
    record('Auth', 'PASS', 'HTTP 200');
    const total = read.data?.total;
    if (typeof total === 'number') record('Live read', 'PASS', `${total} memories for ${config.userId}`);
    else record('Live read', 'FAIL', 'unexpected body — no `total` field');
  } else if (read.status === 401) {
    record('Auth', 'FAIL', '401 — the API key is missing or invalid');
    record('Live read', 'SKIP', 'auth failed');
    failed = true;
  } else if (read.status === 403) {
    record('Auth', 'FAIL', `403 — the key is valid but was not minted for user_id "${config.userId}"`);
    record('Live read', 'SKIP', 'auth failed');
    failed = true;
  } else {
    record('Auth', 'FAIL', `${read.error}${read.status ? ' ' + read.status : ''}`);
    record('Live read', 'SKIP', 'auth failed');
    failed = true;
  }
}

// ---- Check 5: what the hooks themselves last reported -------------------------
const logPath = process.env.CORTADEL_HOOKS_LOG;
if (!logPath) {
  record('Hook outcomes', 'SKIP', 'CORTADEL_HOOKS_LOG not set — set it to a file path to record why each hook stored or injected nothing');
} else if (!existsSync(logPath)) {
  record('Hook outcomes', 'WARN', `${logPath} does not exist yet — no hook has run since it was configured`);
} else {
  const lines = tailLines(logPath, 40);
  const tally = new Map();
  for (const l of lines) {
    try {
      const e = JSON.parse(l);
      const k = `${e.hook}:${e.outcome}${e.reason ? '(' + e.reason + ')' : ''}`;
      tally.set(k, (tally.get(k) || 0) + 1);
    } catch {
      // a partially-written line is not a diagnostic failure
    }
  }
  const summary = [...tally.entries()].sort((a, b) => b[1] - a[1]).map(([k, n]) => `${k}×${n}`).join(' ');
  record('Hook outcomes', 'PASS', `last ${lines.length}: ${summary || '(none parseable)'}`);
}

const warned = rows.some((r) => r.status === 'WARN');
console.log(
  failed
    ? '\nOne or more checks failed. Fix the topmost FAIL first — later checks depend on it.'
    : warned
      ? '\nAll checks passed, with warnings above.'
      : '\nAll checks passed.'
);
process.exitCode = failed ? 1 : 0;
