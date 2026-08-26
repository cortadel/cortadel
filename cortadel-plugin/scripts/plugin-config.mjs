#!/usr/bin/env node
// Shared config resolution for scripts a SKILL runs, as opposed to scripts a HOOK runs.
//
// The distinction matters. Hooks receive their config as CLAUDE_PLUGIN_OPTION_* env vars that
// Claude Code injects into the hook subprocess; those are NOT visible to a skill's own shell.
// So anything invoked from a skill (doctor.mjs, reconcile.mjs) has to also read the config
// Claude Code persisted on disk at install time, or it reports a perfectly healthy install as
// unconfigured.
//
// Extracted from doctor.mjs so reconcile.mjs can reuse it verbatim rather than growing a second,
// subtly different copy. lib.mjs deliberately does NOT gain this: it is the hook path, where the
// env vars are present and reading the user's settings files would be unnecessary I/O on every
// single prompt.
//
// Never prints a secret. Callers get values; where each came from is reported separately so a
// diagnostic can say "resolved from ~/.claude/.credentials.json" without echoing the key.

import { readFileSync, existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

export const PLUGIN_PREFIX = 'cortadel-memory@';

/** Parse a JSON file, or return null (missing/unreadable/malformed all behave the same here). */
export function readJson(p) {
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
export function readInstalledConfig() {
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

export const ENV_FALLBACK = {
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
export function resolve(option, installed) {
  const pluginVar = `CLAUDE_PLUGIN_OPTION_${option.toUpperCase()}`;
  if (process.env[pluginVar]) return { value: process.env[pluginVar], from: pluginVar };
  const envVar = ENV_FALLBACK[option];
  if (process.env[envVar]) return { value: process.env[envVar], from: envVar };
  if (option === 'api_key' && installed.apiKey) return { value: installed.apiKey, from: '~/.claude/.credentials.json' };
  const v = installed.options?.[option];
  if (v) return { value: String(v), from: (installed.source || 'installed config').replace(homedir(), '~') };
  return { value: undefined, from: null };
}

/**
 * Everything a REST call needs, or null with the list of what is missing. Shared by every
 * skill-invoked script so they all fail the same way on an unconfigured install.
 */
export function resolveApiConfig() {
  const installed = readInstalledConfig();
  const baseUrl = resolve('base_url', installed);
  const userId = resolve('user_id', installed);
  const apiKey = resolve('api_key', installed);

  const missing = [
    ['base_url', baseUrl],
    ['user_id', userId],
    ['api_key', apiKey],
  ]
    .filter(([, r]) => !r.value)
    .map(([n]) => n);

  if (missing.length) return { config: null, missing, installed };

  return {
    config: {
      url: String(baseUrl.value).replace(/\/+$/, ''),
      apiKey: apiKey.value,
      userId: userId.value,
    },
    missing: [],
    installed,
  };
}
