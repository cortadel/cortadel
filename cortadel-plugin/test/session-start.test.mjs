import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const SCRIPT = fileURLToPath(new URL('../scripts/session-start.mjs', import.meta.url));

// Both the current and retired names — see lib.test.mjs's own ENV_KEYS comment for why.
const ENV_KEYS = [
  'CORTADEL_URL',
  'CORTADEL_API_KEY',
  'CORTADEL_USER_ID',
  'CORTADEL_CLIENT_NAME',
  'CORTADEL_RECALL_TOPK',
  'CORTADEL_MIN_PROMPT_CHARS',
  'CORTADEL_RECALL_RERANK',
  'CORTADEL_CAPTURE_MAX_CHARS',
  'CORTADEL_HOOKS_DISABLE',
  'MEMFORGE_URL',
  'MEMFORGE_API_KEY',
  'MEMFORGE_USER_ID',
  'MEMFORGE_RECALL_TOPK',
  'MEMFORGE_MIN_PROMPT_CHARS',
  'MEMFORGE_RECALL_RERANK',
  'MEMFORGE_CAPTURE_MAX_CHARS',
  'MEMFORGE_HOOKS_DISABLE',
  'CLAUDE_PLUGIN_OPTION_BASE_URL',
  'CLAUDE_PLUGIN_OPTION_USER_ID',
  'CLAUDE_PLUGIN_OPTION_API_KEY',
  'CLAUDE_PLUGIN_OPTION_CLIENT_NAME',
];

/** Env for the spawned script: inherited minus any plugin var (old or new), plus overrides. */
function makeEnv(overrides = {}) {
  const env = { ...process.env };
  for (const k of ENV_KEYS) delete env[k];
  return { ...env, ...overrides };
}

function requiredEnv(baseUrl, extra = {}) {
  return makeEnv({
    CORTADEL_URL: baseUrl,
    CORTADEL_API_KEY: 'test-key',
    CORTADEL_USER_ID: 'test-user',
    ...extra,
  });
}

/** Spawn the real hook script with fixture stdin; collect exit code + output. */
function runScript(stdinText, env) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [SCRIPT], { env, stdio: ['pipe', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d) => (stdout += d));
    child.stderr.on('data', (d) => (stderr += d));
    child.on('close', (code) => resolve({ code, stdout, stderr }));
    child.stdin.end(stdinText);
  });
}

/** node:http stub on an ephemeral port; records every request. */
function startStub(respond) {
  const requests = [];
  const server = http.createServer((req, res) => {
    let raw = '';
    req.on('data', (d) => (raw += d));
    req.on('end', () => {
      requests.push({
        method: req.method,
        url: req.url,
        auth: req.headers.authorization,
        body: raw ? JSON.parse(raw) : null,
      });
      respond(req, res);
    });
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      resolve({ server, requests, url: `http://127.0.0.1:${port}` });
    });
  });
}

// 2026-07-23T12:00:00Z as Unix SECONDS — the wire contract for created_at.
const CREATED_AT_UNIX_SECONDS = Math.floor(Date.UTC(2026, 6, 23, 12, 0, 0) / 1000);

const FIXTURE_ITEMS = [
  {
    id: 'M1',
    content: 'Phase A embedding guard shipped and validated in prod',
    created_at: CREATED_AT_UNIX_SECONDS,
    state: 'active',
    app_name: 'claude-code-hooks',
    categories: [],
  },
];

const okResponder = (items) => (req, res) => {
  res.writeHead(200, { 'content-type': 'application/json' });
  res.end(JSON.stringify({ items, total: items.length, page: 1, size: 8, pages: 1 }));
};

const STDIN = JSON.stringify({ session_id: 'sess-1', source: 'startup', cwd: 'C:\\repo' });

test('missing config → exit 0, empty stdout, no request', async () => {
  const { server, requests, url } = await startStub(okResponder(FIXTURE_ITEMS));
  try {
    // CORTADEL_API_KEY / USER_ID deliberately absent
    const env = makeEnv({ CORTADEL_URL: url });
    const r = await runScript(STDIN, env);
    assert.equal(r.code, 0);
    assert.equal(r.stdout, '');
    assert.equal(requests.length, 0);
  } finally {
    server.close();
  }
});

test('CORTADEL_HOOKS_DISABLE=1 → exit 0, empty stdout, no request', async () => {
  const { server, requests, url } = await startStub(okResponder(FIXTURE_ITEMS));
  try {
    const r = await runScript(STDIN, requiredEnv(url, { CORTADEL_HOOKS_DISABLE: '1' }));
    assert.equal(r.code, 0);
    assert.equal(r.stdout, '');
    assert.equal(requests.length, 0);
  } finally {
    server.close();
  }
});

test('invalid stdin JSON → exit 0, empty stdout, no request', async () => {
  const { server, requests, url } = await startStub(okResponder(FIXTURE_ITEMS));
  try {
    const r = await runScript('this is not json', requiredEnv(url));
    assert.equal(r.code, 0);
    assert.equal(r.stdout, '');
    assert.equal(requests.length, 0);
  } finally {
    server.close();
  }
});

test('only legacy MEMFORGE_* vars set → still exit 0 empty stdout, no request, but stderr names both vars', async () => {
  const { server, requests, url } = await startStub(okResponder(FIXTURE_ITEMS));
  try {
    const env = makeEnv({
      MEMFORGE_URL: url,
      MEMFORGE_API_KEY: 'legacy-key',
      MEMFORGE_USER_ID: 'legacy-user',
    });
    const r = await runScript(STDIN, env);
    assert.equal(r.code, 0);
    assert.equal(r.stdout, '', 'no fallback: the plugin must stay silent on stdout regardless');
    assert.equal(requests.length, 0, 'no fallback: the legacy URL must never be dialed');
    assert.match(r.stderr, /MEMFORGE_URL/);
    assert.match(r.stderr, /CORTADEL_URL/);
  } finally {
    server.close();
  }
});

test('happy path → GET with user_id/size/page query, Bearer auth, nested SessionStart context', async () => {
  const { server, requests, url } = await startStub(okResponder(FIXTURE_ITEMS));
  try {
    const r = await runScript(STDIN, requiredEnv(url));
    assert.equal(r.code, 0);

    assert.equal(requests.length, 1);
    const req = requests[0];
    assert.equal(req.method, 'GET');
    assert.equal(req.auth, 'Bearer test-key');
    const u = new URL(req.url, 'http://x');
    assert.equal(u.pathname, '/api/v1/memories');
    assert.equal(u.searchParams.get('user_id'), 'test-user', 'query-string user_id must equal env user');
    assert.equal(u.searchParams.get('size'), '8');
    assert.equal(u.searchParams.get('page'), '1');

    const out = JSON.parse(r.stdout);
    assert.equal(out.hookSpecificOutput.hookEventName, 'SessionStart');
    assert.equal(out.suppressOutput, true);
    const ctx = out.hookSpecificOutput.additionalContext;
    assert.ok(ctx.startsWith('## Cortadel memory active'), `header missing in: ${ctx}`);
    assert.ok(
      ctx.includes('Relevant memories are injected automatically on each prompt.'),
      `capability notice missing in: ${ctx}`
    );
    assert.ok(ctx.includes('Recent memories:'), `list header missing in: ${ctx}`);
    // created_at is Unix seconds — must render as 2026-07-23, not 1970.
    assert.ok(
      ctx.includes('- (2026-07-23) Phase A embedding guard shipped'),
      `Unix-seconds date rendering wrong in: ${ctx}`
    );
    assert.ok(!ctx.includes('1970-'), `epoch-milliseconds bug detected in: ${ctx}`);
  } finally {
    server.close();
  }
});

test('empty items → still emits the two-line header, no Recent memories list', async () => {
  const { server, url } = await startStub(okResponder([]));
  try {
    const r = await runScript(STDIN, requiredEnv(url));
    assert.equal(r.code, 0);
    const out = JSON.parse(r.stdout);
    assert.equal(out.hookSpecificOutput.hookEventName, 'SessionStart');
    const ctx = out.hookSpecificOutput.additionalContext;
    assert.ok(ctx.startsWith('## Cortadel memory active'), `header missing in: ${ctx}`);
    assert.ok(
      ctx.includes('Store durable facts explicitly with the cortadel MCP tools when available.'),
      `capability notice missing in: ${ctx}`
    );
    assert.ok(!ctx.includes('Recent memories:'), `empty list must omit the list header: ${ctx}`);
  } finally {
    server.close();
  }
});

test('server 500 → exit 0, empty stdout', async () => {
  const { server, url } = await startStub((req, res) => {
    res.writeHead(500, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ status: 500 }));
  });
  try {
    const r = await runScript(STDIN, requiredEnv(url));
    assert.equal(r.code, 0);
    assert.equal(r.stdout, '');
  } finally {
    server.close();
  }
});

test('connection refused → exit 0, empty stdout', async () => {
  // Grab an ephemeral port, then close the server so nothing listens on it.
  const { server, url } = await startStub(okResponder(FIXTURE_ITEMS));
  await new Promise((resolve) => server.close(resolve));
  const r = await runScript(STDIN, requiredEnv(url));
  assert.equal(r.code, 0);
  assert.equal(r.stdout, '');
});

test('stub sleeping 8 s → exits within 8.5 s with empty stdout (7 s budget aborts)', async () => {
  const { server, url } = await startStub((req, res) => {
    setTimeout(() => {
      try {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ items: FIXTURE_ITEMS }));
      } catch { /* server already closed — fine */ }
    }, 8000).unref();
  });
  try {
    const started = Date.now();
    const r = await runScript(STDIN, requiredEnv(url));
    const elapsed = Date.now() - started;
    assert.equal(r.code, 0);
    assert.equal(r.stdout, '');
    assert.ok(elapsed <= 8500, `expected exit within 8.5s, took ${elapsed}ms`);
  } finally {
    server.closeAllConnections?.();
    server.close();
  }
});
