import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { once } from 'node:events';
import { cfg, api, emitContext, truncate } from '../scripts/lib.mjs';

// Both the current CORTADEL_* names AND the retired MEMFORGE_* names are saved/cleared around
// every test: leaving a stray MEMFORGE_* in the inherited environment would make the
// no-fallback / diagnostic tests below false-negative (they'd pass even if lib.mjs still read the
// old name directly), and would make an incomplete rename fail to show up as a test failure.
const ENV_KEYS = [
  'CORTADEL_URL',
  'CORTADEL_API_KEY',
  'CORTADEL_USER_ID',
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
];

const saved = {};
beforeEach(() => {
  for (const k of ENV_KEYS) {
    saved[k] = process.env[k];
    delete process.env[k];
  }
});
afterEach(() => {
  for (const k of ENV_KEYS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
});

function setRequired() {
  process.env.CORTADEL_URL = 'http://127.0.0.1:9';
  process.env.CORTADEL_API_KEY = 'test-key';
  process.env.CORTADEL_USER_ID = 'test-user';
}

/** Capture stderr writes made during `fn()`; returns the joined text. */
function captureStderr(fn) {
  const writes = [];
  const orig = process.stderr.write;
  process.stderr.write = (chunk) => {
    writes.push(String(chunk));
    return true;
  };
  try {
    fn();
  } finally {
    process.stderr.write = orig;
  }
  return writes.join('');
}

// ---------- cfg() ----------

test('cfg() returns null when CORTADEL_URL missing', () => {
  process.env.CORTADEL_API_KEY = 'k';
  process.env.CORTADEL_USER_ID = 'u';
  assert.equal(cfg(), null);
});

test('cfg() returns null when CORTADEL_API_KEY missing', () => {
  process.env.CORTADEL_URL = 'http://x';
  process.env.CORTADEL_USER_ID = 'u';
  assert.equal(cfg(), null);
});

test('cfg() returns null when CORTADEL_USER_ID missing', () => {
  process.env.CORTADEL_URL = 'http://x';
  process.env.CORTADEL_API_KEY = 'k';
  assert.equal(cfg(), null);
});

test('cfg() returns null when CORTADEL_HOOKS_DISABLE=1', () => {
  setRequired();
  process.env.CORTADEL_HOOKS_DISABLE = '1';
  assert.equal(cfg(), null);
});

test('cfg() parses defaults', () => {
  setRequired();
  const c = cfg();
  assert.ok(c);
  assert.equal(c.url, 'http://127.0.0.1:9');
  assert.equal(c.apiKey, 'test-key');
  assert.equal(c.userId, 'test-user');
  assert.equal(c.topK, 3);
  assert.equal(c.minPromptChars, 10);
  assert.equal(c.rerank, undefined);
  assert.equal(c.captureMaxChars, 16000);
});

test('cfg() respects overrides', () => {
  setRequired();
  process.env.CORTADEL_RECALL_TOPK = '7';
  process.env.CORTADEL_MIN_PROMPT_CHARS = '25';
  process.env.CORTADEL_RECALL_RERANK = 'cross_encoder';
  process.env.CORTADEL_CAPTURE_MAX_CHARS = '9000';
  const c = cfg();
  assert.ok(c);
  assert.equal(c.topK, 7);
  assert.equal(c.minPromptChars, 25);
  assert.equal(c.rerank, 'cross_encoder');
  assert.equal(c.captureMaxChars, 9000);
});

test('cfg() floors captureMaxChars at 8000 (Stop reserves 4000 for the user turn)', () => {
  setRequired();
  process.env.CORTADEL_CAPTURE_MAX_CHARS = '2000';
  const c = cfg();
  assert.ok(c);
  assert.equal(c.captureMaxChars, 8000);
});

test('cfg() strips trailing slash from url', () => {
  setRequired();
  process.env.CORTADEL_URL = 'http://127.0.0.1:9/';
  const c = cfg();
  assert.equal(c.url, 'http://127.0.0.1:9');
});

// ---------- renamed env vars: no fallback, loud diagnostic ----------
// Env vars were renamed MEMFORGE_* -> CORTADEL_* outright, with no backward-compatible fallback.
// These tests prove both halves of that: the old value is NEVER read as configuration (so an
// incomplete rename that left a `process.env.MEMFORGE_X` read somewhere would fail these), and a
// still-set old variable produces a clear diagnostic naming both the old and new name.

test('cfg() returns null (unconfigured) when only legacy MEMFORGE_* vars are set — no fallback', () => {
  process.env.MEMFORGE_URL = 'http://127.0.0.1:9';
  process.env.MEMFORGE_API_KEY = 'legacy-key';
  process.env.MEMFORGE_USER_ID = 'legacy-user';
  const out = captureStderr(() => {
    assert.equal(cfg(), null, 'the legacy MEMFORGE_* trio must never configure the plugin');
  });
  assert.match(out, /MEMFORGE_URL/, 'diagnostic must name the old variable');
  assert.match(out, /CORTADEL_URL/, 'diagnostic must name the new variable');
  assert.match(out, /MEMFORGE_API_KEY/);
  assert.match(out, /CORTADEL_API_KEY/);
  assert.match(out, /MEMFORGE_USER_ID/);
  assert.match(out, /CORTADEL_USER_ID/);
});

test('cfg() ignores a legacy MEMFORGE_URL value even when the other two required vars are new-style', () => {
  process.env.MEMFORGE_URL = 'http://evil.example';
  process.env.CORTADEL_API_KEY = 'k';
  process.env.CORTADEL_USER_ID = 'u';
  const out = captureStderr(() => {
    assert.equal(cfg(), null, 'CORTADEL_URL is still missing, so the plugin stays unconfigured');
  });
  assert.match(out, /MEMFORGE_URL/);
  assert.match(out, /CORTADEL_URL/);
  // Only the URL diagnostic should fire — the other two vars are already new-style.
  assert.ok(!out.includes('MEMFORGE_API_KEY'), 'no spurious diagnostic for an already-migrated var');
  assert.ok(!out.includes('MEMFORGE_USER_ID'), 'no spurious diagnostic for an already-migrated var');
});

test('cfg() emits no diagnostic when nothing legacy is set', () => {
  setRequired();
  const out = captureStderr(() => {
    assert.ok(cfg());
  });
  assert.equal(out, '');
});

test('cfg() emits no diagnostic when both old and new names are set (new wins silently)', () => {
  setRequired();
  process.env.MEMFORGE_URL = 'http://should-be-ignored.example';
  const out = captureStderr(() => {
    const c = cfg();
    assert.equal(c.url, 'http://127.0.0.1:9', 'the new-style value must win, unmodified');
  });
  assert.equal(out, '', 'no diagnostic once the new variable is actually set');
});

test('cfg() falls back to the documented default for an optional var when only its legacy name is set, and warns', () => {
  setRequired();
  process.env.MEMFORGE_RECALL_TOPK = '99';
  const out = captureStderr(() => {
    const c = cfg();
    assert.equal(c.topK, 3, 'the legacy value must never be read — default applies as if unset');
  });
  assert.match(out, /MEMFORGE_RECALL_TOPK/);
  assert.match(out, /CORTADEL_RECALL_TOPK/);
});

test('cfg() legacy MEMFORGE_HOOKS_DISABLE=1 does NOT disable the plugin — new var wins, warns', () => {
  setRequired();
  process.env.MEMFORGE_HOOKS_DISABLE = '1';
  const out = captureStderr(() => {
    const c = cfg();
    assert.ok(c, 'an unmigrated MEMFORGE_HOOKS_DISABLE must not silently keep the plugin disabled');
  });
  assert.match(out, /MEMFORGE_HOOKS_DISABLE/);
  assert.match(out, /CORTADEL_HOOKS_DISABLE/);
});

// ---------- truncate ----------

test('truncate returns short strings unchanged', () => {
  assert.equal(truncate('abc', 10), 'abc');
  assert.equal(truncate('abc', 3), 'abc');
});

test('truncate bounds long strings to max chars with ellipsis', () => {
  const out = truncate('abcdefghij', 5);
  assert.equal(out.length, 5);
  assert.ok(out.endsWith('…'));
  assert.equal(out, 'abcd…');
});

test('truncate handles empty and non-string input safely', () => {
  assert.equal(truncate('', 5), '');
  assert.equal(truncate(null, 5), '');
  assert.equal(truncate(undefined, 5), '');
});

// ---------- api ----------

function startStub(handler) {
  const server = http.createServer(handler);
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      resolve({ server, url: `http://127.0.0.1:${port}` });
    });
  });
}

test('api() sends Bearer auth + JSON body and returns parsed JSON on 200', async () => {
  let seen = null;
  const { server, url } = await startStub((req, res) => {
    let raw = '';
    req.on('data', (d) => (raw += d));
    req.on('end', () => {
      seen = { method: req.method, url: req.url, auth: req.headers.authorization, body: raw };
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ ok: true, results: [1, 2] }));
    });
  });
  try {
    setRequired();
    process.env.CORTADEL_URL = url;
    const c = cfg();
    const out = await api(c, 'POST', '/api/v1/memories/search', {
      body: { query: 'q', user_id: c.userId },
      timeoutMs: 5000,
    });
    assert.deepEqual(out, { ok: true, results: [1, 2] });
    assert.equal(seen.method, 'POST');
    assert.equal(seen.url, '/api/v1/memories/search');
    assert.equal(seen.auth, 'Bearer test-key');
    assert.deepEqual(JSON.parse(seen.body), { query: 'q', user_id: 'test-user' });
  } finally {
    server.close();
  }
});

test('api() appends query params on GET', async () => {
  let seenUrl = null;
  const { server, url } = await startStub((req, res) => {
    seenUrl = req.url;
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ items: [] }));
  });
  try {
    setRequired();
    process.env.CORTADEL_URL = url;
    const c = cfg();
    const out = await api(c, 'GET', '/api/v1/memories', {
      query: { user_id: 'test-user', size: 8 },
      timeoutMs: 5000,
    });
    assert.deepEqual(out, { items: [] });
    const u = new URL(seenUrl, url);
    assert.equal(u.pathname, '/api/v1/memories');
    assert.equal(u.searchParams.get('user_id'), 'test-user');
    assert.equal(u.searchParams.get('size'), '8');
  } finally {
    server.close();
  }
});

test('api() returns null on 500', async () => {
  const { server, url } = await startStub((req, res) => {
    res.writeHead(500, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ status: 500 }));
  });
  try {
    setRequired();
    process.env.CORTADEL_URL = url;
    const out = await api(cfg(), 'GET', '/api/v1/memories', { timeoutMs: 5000 });
    assert.equal(out, null);
  } finally {
    server.close();
  }
});

test('api() returns null on timeout (abort)', async () => {
  const { server, url } = await startStub((req, res) => {
    // never respond within budget
    setTimeout(() => {
      try {
        res.writeHead(200);
        res.end('{}');
      } catch { /* server already closed — fine */ }
    }, 2000).unref();
  });
  try {
    setRequired();
    process.env.CORTADEL_URL = url;
    const started = Date.now();
    const out = await api(cfg(), 'GET', '/api/v1/memories', { timeoutMs: 300 });
    assert.equal(out, null);
    assert.ok(Date.now() - started < 1500, 'aborted well before stub responded');
  } finally {
    server.closeAllConnections?.();
    server.close();
  }
});

test('api() returns null on connection refused', async () => {
  // grab a port then close it so nothing is listening
  const { server, url } = await startStub(() => {});
  server.close();
  await once(server, 'close');
  setRequired();
  process.env.CORTADEL_URL = url;
  const out = await api(cfg(), 'GET', '/api/v1/memories', { timeoutMs: 2000 });
  assert.equal(out, null);
});

// ---------- emitContext ----------

test('emitContext prints exactly the nested hookSpecificOutput contract', () => {
  const writes = [];
  const orig = process.stdout.write;
  process.stdout.write = (chunk) => {
    writes.push(String(chunk));
    return true;
  };
  try {
    emitContext('UserPromptSubmit', 'hello block');
  } finally {
    process.stdout.write = orig;
  }
  const out = writes.join('');
  const parsed = JSON.parse(out);
  assert.deepEqual(parsed, {
    hookSpecificOutput: {
      hookEventName: 'UserPromptSubmit',
      additionalContext: 'hello block',
    },
    suppressOutput: true,
  });
});

// ---------- readStdin ----------

test('readStdin parses piped JSON via a spawned child', async () => {
  const { spawn } = await import('node:child_process');
  const child = spawn(
    process.execPath,
    [
      '--input-type=module',
      '-e',
      `import { readStdin } from ${JSON.stringify(new URL('../scripts/lib.mjs', import.meta.url).href)};
       const v = await readStdin();
       process.stdout.write(JSON.stringify(v));`,
    ],
    { stdio: ['pipe', 'pipe', 'pipe'] }
  );
  child.stdin.end('{"prompt":"hi"}');
  let out = '';
  child.stdout.on('data', (d) => (out += d));
  const [code] = await once(child, 'close');
  assert.equal(code, 0);
  assert.deepEqual(JSON.parse(out), { prompt: 'hi' });
});

test('readStdin returns null on invalid JSON via a spawned child', async () => {
  const { spawn } = await import('node:child_process');
  const child = spawn(
    process.execPath,
    [
      '--input-type=module',
      '-e',
      `import { readStdin } from ${JSON.stringify(new URL('../scripts/lib.mjs', import.meta.url).href)};
       const v = await readStdin();
       process.stdout.write(String(v));`,
    ],
    { stdio: ['pipe', 'pipe', 'pipe'] }
  );
  child.stdin.end('not json at all');
  let out = '';
  child.stdout.on('data', (d) => (out += d));
  const [code] = await once(child, 'close');
  assert.equal(code, 0);
  assert.equal(out, 'null');
});
