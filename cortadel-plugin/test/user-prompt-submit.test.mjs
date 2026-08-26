import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const SCRIPT = fileURLToPath(new URL('../scripts/user-prompt-submit.mjs', import.meta.url));

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

const okResponder = (results) => (req, res) => {
  res.writeHead(200, { 'content-type': 'application/json' });
  res.end(JSON.stringify({ query: 'q', results, total: results.length }));
};

const FIXTURE_RESULTS = [
  {
    id: '4F7K2',
    rrf_score: 0.83,
    content: 'GPU reranker lives on the A5000 and serves bge int8 at 384 tokens',
    categories: [],
    tags: [],
    created_at: '2026-07-21T09:30:00Z',
    app_name: 'claude-code-hooks',
  },
];

test('missing config → exit 0, empty stdout, no request', async () => {
  const { server, requests, url } = await startStub(okResponder(FIXTURE_RESULTS));
  try {
    // CORTADEL_API_KEY / USER_ID deliberately absent
    const env = makeEnv({ CORTADEL_URL: url });
    const r = await runScript(JSON.stringify({ prompt: 'a perfectly normal question about things' }), env);
    assert.equal(r.code, 0);
    assert.equal(r.stdout, '');
    assert.equal(requests.length, 0);
  } finally {
    server.close();
  }
});

test('only legacy MEMFORGE_* vars set → still exit 0 empty stdout, no request, but stderr names both vars', async () => {
  const { server, requests, url } = await startStub(okResponder(FIXTURE_RESULTS));
  try {
    const env = makeEnv({
      MEMFORGE_URL: url,
      MEMFORGE_API_KEY: 'legacy-key',
      MEMFORGE_USER_ID: 'legacy-user',
    });
    const r = await runScript(JSON.stringify({ prompt: 'a perfectly normal question about things' }), env);
    assert.equal(r.code, 0);
    assert.equal(r.stdout, '');
    assert.equal(requests.length, 0, 'no fallback: the legacy URL must never be dialed');
    assert.match(r.stderr, /MEMFORGE_URL/);
    assert.match(r.stderr, /CORTADEL_URL/);
    assert.match(r.stderr, /MEMFORGE_API_KEY/);
    assert.match(r.stderr, /CORTADEL_API_KEY/);
    assert.match(r.stderr, /MEMFORGE_USER_ID/);
    assert.match(r.stderr, /CORTADEL_USER_ID/);
  } finally {
    server.close();
  }
});

test('short prompt → no request, empty stdout', async () => {
  const { server, requests, url } = await startStub(okResponder(FIXTURE_RESULTS));
  try {
    const r = await runScript(JSON.stringify({ prompt: 'hi' }), requiredEnv(url));
    assert.equal(r.code, 0);
    assert.equal(r.stdout, '');
    assert.equal(requests.length, 0);
  } finally {
    server.close();
  }
});

test('slash command → skipped', async () => {
  const { server, requests, url } = await startStub(okResponder(FIXTURE_RESULTS));
  try {
    const r = await runScript(JSON.stringify({ prompt: '/compact and then do more things' }), requiredEnv(url));
    assert.equal(r.code, 0);
    assert.equal(r.stdout, '');
    assert.equal(requests.length, 0);
  } finally {
    server.close();
  }
});

test('shell prefix (!) → skipped', async () => {
  const { server, requests, url } = await startStub(okResponder(FIXTURE_RESULTS));
  try {
    const r = await runScript(JSON.stringify({ prompt: '!git status --short please' }), requiredEnv(url));
    assert.equal(r.code, 0);
    assert.equal(r.stdout, '');
    assert.equal(requests.length, 0);
  } finally {
    server.close();
  }
});

test('invalid stdin JSON / missing prompt → exit 0, no request', async () => {
  const { server, requests, url } = await startStub(okResponder(FIXTURE_RESULTS));
  try {
    const bad = await runScript('this is not json', requiredEnv(url));
    assert.equal(bad.code, 0);
    assert.equal(bad.stdout, '');
    const noPrompt = await runScript(JSON.stringify({ session_id: 'x' }), requiredEnv(url));
    assert.equal(noPrompt.code, 0);
    assert.equal(noPrompt.stdout, '');
    assert.equal(requests.length, 0);
  } finally {
    server.close();
  }
});

test('normal prompt → exact request body (no rerank key) + nested context output', async () => {
  const { server, requests, url } = await startStub(okResponder(FIXTURE_RESULTS));
  try {
    const prompt = 'how does the GPU reranker deployment work?';
    const r = await runScript(JSON.stringify({ prompt }), requiredEnv(url));
    assert.equal(r.code, 0);

    assert.equal(requests.length, 1);
    const req = requests[0];
    assert.equal(req.method, 'POST');
    assert.equal(req.url, '/api/v1/memories/search');
    assert.equal(req.auth, 'Bearer test-key');
    assert.deepEqual(req.body, {
      query: prompt,
      user_id: 'test-user',
      app_name: 'claude',
      top_k: 3,
      mode: 'hybrid',
    });
    assert.ok(!('rerank' in req.body), 'rerank must be omitted entirely when env unset');

    const out = JSON.parse(r.stdout);
    assert.equal(out.hookSpecificOutput.hookEventName, 'UserPromptSubmit');
    assert.equal(out.suppressOutput, true);
    const ctx = out.hookSpecificOutput.additionalContext;
    assert.ok(ctx.startsWith('## Relevant Cortadel memories'), `header missing in: ${ctx}`);
    assert.ok(ctx.includes('- (2026-07-21, score 0.83) [id 4F7K2] GPU reranker lives on the A5000'), `memory line missing in: ${ctx}`);
  } finally {
    server.close();
  }
});

test('CORTADEL_RECALL_RERANK=cross_encoder → rerank included in body', async () => {
  const { server, requests, url } = await startStub(okResponder(FIXTURE_RESULTS));
  try {
    const env = requiredEnv(url, { CORTADEL_RECALL_RERANK: 'cross_encoder', CORTADEL_RECALL_TOPK: '5' });
    const r = await runScript(JSON.stringify({ prompt: 'another sufficiently long prompt here' }), env);
    assert.equal(r.code, 0);
    assert.equal(requests.length, 1);
    assert.equal(requests[0].body.rerank, 'cross_encoder');
    assert.equal(requests[0].body.top_k, 5);
  } finally {
    server.close();
  }
});

// ---------- client_name -> app_name wiring ----------
// app_name must come from cfg().clientName (never a hard-coded string), so the hooks and the MCP
// server ({clientName} path segment) agree on the same app label. End-to-end via the real
// spawned hook process, covering both the CORTADEL_CLIENT_NAME dev-flow surface and the
// CLAUDE_PLUGIN_OPTION_CLIENT_NAME surface Claude Code injects for an installed plugin.

test('CORTADEL_CLIENT_NAME reaches app_name in the request body', async () => {
  const { server, requests, url } = await startStub(okResponder(FIXTURE_RESULTS));
  try {
    const env = requiredEnv(url, { CORTADEL_CLIENT_NAME: 'my-custom-agent' });
    const r = await runScript(JSON.stringify({ prompt: 'a perfectly normal question about things' }), env);
    assert.equal(r.code, 0);
    assert.equal(requests.length, 1);
    assert.equal(requests[0].body.app_name, 'my-custom-agent');
  } finally {
    server.close();
  }
});

test('CLAUDE_PLUGIN_OPTION_CLIENT_NAME reaches app_name and wins over CORTADEL_CLIENT_NAME', async () => {
  const { server, requests, url } = await startStub(okResponder(FIXTURE_RESULTS));
  try {
    const env = requiredEnv(url, {
      CORTADEL_CLIENT_NAME: 'dev-flow-name',
      CLAUDE_PLUGIN_OPTION_CLIENT_NAME: 'installed-plugin-name',
    });
    const r = await runScript(JSON.stringify({ prompt: 'a perfectly normal question about things' }), env);
    assert.equal(r.code, 0);
    assert.equal(requests.length, 1);
    assert.equal(requests[0].body.app_name, 'installed-plugin-name');
  } finally {
    server.close();
  }
});

test('CLAUDE_PLUGIN_OPTION_* alone (no CORTADEL_* set) configures and reaches app_name', async () => {
  const { server, requests, url } = await startStub(okResponder(FIXTURE_RESULTS));
  try {
    const env = makeEnv({
      CLAUDE_PLUGIN_OPTION_BASE_URL: url,
      CLAUDE_PLUGIN_OPTION_API_KEY: 'plugin-key',
      CLAUDE_PLUGIN_OPTION_USER_ID: 'plugin-user',
      CLAUDE_PLUGIN_OPTION_CLIENT_NAME: 'plugin-client',
    });
    const r = await runScript(JSON.stringify({ prompt: 'a perfectly normal question about things' }), env);
    assert.equal(r.code, 0);
    assert.equal(requests.length, 1);
    assert.equal(requests[0].auth, 'Bearer plugin-key');
    assert.equal(requests[0].body.user_id, 'plugin-user');
    assert.equal(requests[0].body.app_name, 'plugin-client');
  } finally {
    server.close();
  }
});

test('query is bounded to 4000 chars', async () => {
  const { server, requests, url } = await startStub(okResponder(FIXTURE_RESULTS));
  try {
    const prompt = 'x'.repeat(6000);
    const r = await runScript(JSON.stringify({ prompt }), requiredEnv(url));
    assert.equal(r.code, 0);
    assert.equal(requests.length, 1);
    assert.equal(requests[0].body.query.length, 4000);
  } finally {
    server.close();
  }
});

test('empty results → exit 0, empty stdout', async () => {
  const { server, url } = await startStub(okResponder([]));
  try {
    const r = await runScript(JSON.stringify({ prompt: 'a normal question with zero matches' }), requiredEnv(url));
    assert.equal(r.code, 0);
    assert.equal(r.stdout, '');
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
    const r = await runScript(JSON.stringify({ prompt: 'a normal question that will 500' }), requiredEnv(url));
    assert.equal(r.code, 0);
    assert.equal(r.stdout, '');
  } finally {
    server.close();
  }
});

test('stub sleeping 13 s → exits within 13.5 s with empty stdout (abort works)', async () => {
  const { server, url } = await startStub((req, res) => {
    setTimeout(() => {
      try {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ results: FIXTURE_RESULTS }));
      } catch { /* server already closed — fine */ }
    }, 13000).unref();
  });
  try {
    const started = Date.now();
    const r = await runScript(JSON.stringify({ prompt: 'a normal question against a hung server' }), requiredEnv(url));
    const elapsed = Date.now() - started;
    assert.equal(r.code, 0);
    assert.equal(r.stdout, '');
    assert.ok(elapsed <= 13500, `expected exit within 13.5s, took ${elapsed}ms`);
  } finally {
    server.closeAllConnections?.();
    server.close();
  }
});
