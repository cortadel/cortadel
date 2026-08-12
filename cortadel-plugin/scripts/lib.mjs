// Shared library for the cortadel-memory Claude Code plugin hooks.
// Zero dependencies, Node 18+ (built-in fetch). Everything fails open:
// any error path yields null / empty output so hooks can exit 0 silently.

// This plugin's env vars were renamed MEMFORGE_* -> CORTADEL_* with NO
// backward-compatible fallback: the old names are never read as working
// configuration. An outright rename like that fails *silently* for an
// existing install — the plugin just stops finding a server, with no
// obvious cause — so readEnv() below detects "the old name is still set,
// the new name is not" and emits a loud diagnostic to stderr naming BOTH
// variables, then proceeds exactly as if the new variable were unset. This
// is a diagnostic, not a fallback: the old value itself is never used.
const RENAMED_ENV_VARS = {
  CORTADEL_URL: 'MEMFORGE_URL',
  CORTADEL_API_KEY: 'MEMFORGE_API_KEY',
  CORTADEL_USER_ID: 'MEMFORGE_USER_ID',
  CORTADEL_RECALL_TOPK: 'MEMFORGE_RECALL_TOPK',
  CORTADEL_MIN_PROMPT_CHARS: 'MEMFORGE_MIN_PROMPT_CHARS',
  CORTADEL_RECALL_RERANK: 'MEMFORGE_RECALL_RERANK',
  CORTADEL_CAPTURE_MAX_CHARS: 'MEMFORGE_CAPTURE_MAX_CHARS',
  CORTADEL_HOOKS_DISABLE: 'MEMFORGE_HOOKS_DISABLE',
};

/**
 * Read a plugin env var by its current CORTADEL_* name. If it is unset but
 * the retired MEMFORGE_* counterpart is set, this is almost certainly an
 * unmigrated install: warn on stderr naming both the old and new variable,
 * and return undefined regardless — the old value is never read as config.
 */
function readEnv(env, name) {
  const v = env[name];
  if (v !== undefined) return v;
  const oldName = RENAMED_ENV_VARS[name];
  if (oldName && env[oldName] !== undefined) {
    process.stderr.write(
      `[cortadel-memory] ${oldName} is set, but this plugin now reads ${name} instead. ` +
        `MEMFORGE_* environment variables were renamed to CORTADEL_* with no backward-compatible ` +
        `fallback — set ${name} (the value of ${oldName} is ignored). Treating this as ` +
        `unconfigured until you do.\n`
    );
  }
  return undefined;
}

// The plugin's four userConfig options (packaging/plugin.metadata.json) map 1:1 to these two env
// tiers. When Claude Code installs the plugin from the marketplace, resolved userConfig values
// are injected into hook child processes as `CLAUDE_PLUGIN_OPTION_<KEY>` (key upper-cased) — see
// https://code.claude.com/docs/en/hooks (Plugin User Config Injection). That tier always wins.
// Below it, `CORTADEL_<name>` is the pre-existing manual configuration surface: the
// `--plugin-dir` dev flow, CI, or anyone running the hook scripts outside an installed plugin.
// It is routed through readEnv() so the MEMFORGE_* rename diagnostic above still fires there too.
const USER_CONFIG_OPTIONS = {
  base_url: 'CORTADEL_URL',
  user_id: 'CORTADEL_USER_ID',
  api_key: 'CORTADEL_API_KEY',
  client_name: 'CORTADEL_CLIENT_NAME',
};

/** Read one userConfig-backed option: CLAUDE_PLUGIN_OPTION_<KEY> first, then CORTADEL_<name>. */
function readOption(env, optionKey) {
  const pluginVar = `CLAUDE_PLUGIN_OPTION_${optionKey.toUpperCase()}`;
  if (env[pluginVar] !== undefined) return env[pluginVar];
  return readEnv(env, USER_CONFIG_OPTIONS[optionKey]);
}

/**
 * Read plugin configuration from environment variables. Returns null when
 * any required variable is missing or the hooks are disabled.
 */
export function cfg() {
  const env = process.env;
  if (readEnv(env, 'CORTADEL_HOOKS_DISABLE') === '1') return null;
  const url = readOption(env, 'base_url');
  const apiKey = readOption(env, 'api_key');
  const userId = readOption(env, 'user_id');
  if (!url || !apiKey || !userId) return null;

  const num = (v, dflt) => {
    const n = Number.parseInt(v, 10);
    return Number.isFinite(n) && n > 0 ? n : dflt;
  };

  return {
    url: url.replace(/\/+$/, ''),
    apiKey,
    userId,
    // Also the {clientName} path segment of the MCP endpoint (packaging/plugin.metadata.json's
    // mcp.urlTemplate) — the hooks and the MCP server must agree on this label.
    clientName: readOption(env, 'client_name') || 'claude-code',
    topK: num(readEnv(env, 'CORTADEL_RECALL_TOPK'), 3),
    minPromptChars: num(readEnv(env, 'CORTADEL_MIN_PROMPT_CHARS'), 10),
    rerank: readEnv(env, 'CORTADEL_RECALL_RERANK') || undefined,
    // Floor 8000: the Stop capture reserves 4000 chars for the user turn, so
    // anything lower would leave the assistant turn a zero/ellipsis budget.
    captureMaxChars: Math.max(8000, num(readEnv(env, 'CORTADEL_CAPTURE_MAX_CHARS'), 16000)),
    disabled: false,
  };
}

/**
 * Read all of stdin and parse it as JSON. Returns null on any failure.
 */
export async function readStdin() {
  try {
    let raw = '';
    for await (const chunk of process.stdin) raw += chunk;
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

/**
 * Minimal fetch wrapper: Bearer auth, JSON in/out, AbortController budget.
 * Returns parsed JSON on 2xx, null on ANY failure (non-2xx, abort, network).
 */
export async function api(config, method, path, { body, query, timeoutMs = 10000 } = {}) {
  try {
    const url = new URL(config.url + path);
    if (query) {
      for (const [k, v] of Object.entries(query)) {
        if (v !== undefined && v !== null) url.searchParams.set(k, String(v));
      }
    }
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const res = await fetch(url, {
        method,
        headers: {
          authorization: `Bearer ${config.apiKey}`,
          ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
        },
        ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
        signal: controller.signal,
      });
      if (!res.ok) return null;
      return await res.json();
    } finally {
      clearTimeout(timer);
    }
  } catch {
    return null;
  }
}

/**
 * Print the hook context-injection contract to stdout. The additionalContext
 * MUST be nested under hookSpecificOutput — top-level is silently ignored.
 */
export function emitContext(eventName, text) {
  process.stdout.write(
    JSON.stringify({
      hookSpecificOutput: {
        hookEventName: eventName,
        additionalContext: text,
      },
      suppressOutput: true,
    })
  );
}

/**
 * Char-bounded truncation with a single-char ellipsis; result length <= max.
 */
export function truncate(s, max) {
  if (typeof s !== 'string') return '';
  if (s.length <= max) return s;
  return s.slice(0, Math.max(0, max - 1)) + '…';
}
