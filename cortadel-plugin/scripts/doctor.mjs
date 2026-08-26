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

import { existsSync, statSync, openSync, readSync, closeSync } from 'node:fs';
import { apiDetailed } from './lib.mjs';
// Shared with reconcile.mjs — see plugin-config.mjs for why skill-invoked scripts cannot rely on
// the CLAUDE_PLUGIN_OPTION_* env vars the hooks get.
import { readInstalledConfig, resolve } from './plugin-config.mjs';

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

// The inline MCP server's url is a LITERAL (packaging/plugin.metadata.json's mcp.urlTemplate):
// Claude Desktop and claude.ai copy mcpServers[].url verbatim without substituting plugin options,
// so it cannot be templated from base_url without breaking those surfaces. That means a self-hosted
// base_url moves the HOOKS but not MCP, and the two would then write to different servers. Silent
// split-brain is the worst outcome, so say it plainly.
const HOSTED_ORIGIN = 'https://app.cortadel.ai';
if (!missing.length && String(baseUrl.value).replace(/\/+$/, '') !== HOSTED_ORIGIN) {
  record(
    'Hooks/MCP target agreement',
    'WARN',
    `base_url=${baseUrl.value} but the inline MCP server is pinned to ${HOSTED_ORIGIN}/mcp/claude — ` +
      'the hooks and the MCP tools are talking to DIFFERENT servers. Self-hosting? Add your own MCP ' +
      `server too: claude mcp add --transport http cortadel-local ${String(baseUrl.value).replace(/\/+$/, '')}/mcp/claude ` +
      '--header "Authorization: Bearer <your-key>"'
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
