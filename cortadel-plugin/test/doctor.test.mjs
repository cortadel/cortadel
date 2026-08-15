// doctor.mjs is the one component that must NOT fail open — its whole job is
// telling failure modes apart. These tests pin that, plus the bug that made the
// previous prose version report healthy installs as broken: config that lives on
// disk (marketplace install) rather than in the environment.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { mkdtempSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

const DOCTOR = fileURLToPath(new URL('../scripts/doctor.mjs', import.meta.url));

const ENV_KEYS = [
  'CORTADEL_URL', 'CORTADEL_API_KEY', 'CORTADEL_USER_ID', 'CORTADEL_CLIENT_NAME',
  'CORTADEL_HOOKS_DISABLE', 'CORTADEL_HOOKS_LOG',
  'CLAUDE_PLUGIN_OPTION_BASE_URL', 'CLAUDE_PLUGIN_OPTION_USER_ID',
  'CLAUDE_PLUGIN_OPTION_API_KEY', 'CLAUDE_PLUGIN_OPTION_CLIENT_NAME',
];

const SECRET = 'super-secret-key-value';

/**
 * A throwaway HOME containing exactly what a marketplace install leaves behind:
 * non-sensitive options in settings.json, the key in .credentials.json. Both are
 * keyed `<plugin>@<marketplace>`, so the marketplace half is deliberately not
 * the one the plugin ships with — doctor must match on the prefix.
 */
function fakeHome({ options, withSecret = true }) {
  const home = mkdtempSync(path.join(tmpdir(), 'cortadel-home-'));
  mkdirSync(path.join(home, '.claude'), { recursive: true });
  writeFileSync(
    path.join(home, '.claude', 'settings.json'),
    JSON.stringify({ pluginConfigs: { 'cortadel-memory@some-other-marketplace': { options } } })
  );
  if (withSecret) {
    writeFileSync(
      path.join(home, '.claude', '.credentials.json'),
      JSON.stringify({ pluginSecrets: { 'cortadel-memory@some-other-marketplace': { api_key: SECRET } } })
    );
  }
  return home;
}

function makeEnv(overrides = {}) {
  const env = { ...process.env };
  for (const k of ENV_KEYS) delete env[k];
  // Point homedir() at a directory with no plugin config unless a test supplies one.
  const empty = mkdtempSync(path.join(tmpdir(), 'cortadel-nohome-'));
  return { ...env, HOME: empty, USERPROFILE: empty, ...overrides };
}

function run(env) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [DOCTOR], { env, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d) => (stdout += d));
    child.stderr.on('data', (d) => (stderr += d));
    child.on('close', (code) => resolve({ code, stdout, stderr }));
  });
}

function startStub(routes) {
  const server = http.createServer((req, res) => {
    const route = routes[req.url.split('?')[0]];
    if (!route) {
      res.writeHead(404, { 'content-type': 'application/json' });
      return res.end('{}');
    }
    res.writeHead(route.status ?? 200, { 'content-type': 'application/json' });
    res.end(JSON.stringify(route.body ?? {}));
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => resolve({ server, url: `http://127.0.0.1:${server.address().port}` }));
  });
}

const HEALTHY = {
  '/api/health': { body: { status: 'ok', checks: { memgraph: { ok: true }, embeddings: { ok: true } } } },
  '/api/v1/memories': { body: { items: [], total: 42 } },
};

test('resolves config Claude Code persisted on disk — the marketplace-install case', async () => {
  const { server, url } = await startStub(HEALTHY);
  try {
    const home = fakeHome({ options: { base_url: url, user_id: 'e2e-doctor', client_name: 'claude' } });
    const r = await run(makeEnv({ HOME: home, USERPROFILE: home }));
    assert.equal(r.code, 0, r.stdout);
    assert.match(r.stdout, /PASS\s+Config resolution/);
    assert.match(r.stdout, /credentials\.json/, 'reports which tier the key came from');
    assert.match(r.stdout, /PASS\s+Live read\s+42 memories/);
    assert.match(r.stdout, /All checks passed/);
  } finally {
    server.close();
  }
});

test('never prints the API key value', async () => {
  const { server, url } = await startStub(HEALTHY);
  try {
    const home = fakeHome({ options: { base_url: url, user_id: 'e2e-doctor' } });
    const r = await run(makeEnv({ HOME: home, USERPROFILE: home }));
    assert.ok(!r.stdout.includes(SECRET), 'the key must never reach stdout');
    assert.ok(!r.stderr.includes(SECRET), 'the key must never reach stderr');
    assert.match(r.stdout, /api_key=<resolved>/);
  } finally {
    server.close();
  }
});

test('environment tier wins over the on-disk tier', async () => {
  const { server, url } = await startStub(HEALTHY);
  try {
    const home = fakeHome({ options: { base_url: 'http://127.0.0.1:1/wrong', user_id: 'from-disk' } });
    const r = await run(makeEnv({
      HOME: home, USERPROFILE: home,
      CLAUDE_PLUGIN_OPTION_BASE_URL: url,
      CLAUDE_PLUGIN_OPTION_USER_ID: 'from-env',
      CLAUDE_PLUGIN_OPTION_API_KEY: 'k',
    }));
    assert.equal(r.code, 0, r.stdout);
    assert.match(r.stdout, /user_id=from-env/);
  } finally {
    server.close();
  }
});

test('unconfigured → FAIL naming every missing option, exit 1', async () => {
  const r = await run(makeEnv());
  assert.equal(r.code, 1);
  assert.match(r.stdout, /FAIL\s+Config resolution/);
  for (const opt of ['base_url', 'user_id', 'api_key']) assert.match(r.stdout, new RegExp(opt));
  assert.match(r.stdout, /silent no-ops/);
});

test('missing key only → still FAIL (the hooks need all three)', async () => {
  const { server, url } = await startStub(HEALTHY);
  try {
    const home = fakeHome({ options: { base_url: url, user_id: 'e2e-doctor' }, withSecret: false });
    const r = await run(makeEnv({ HOME: home, USERPROFILE: home }));
    assert.equal(r.code, 1);
    assert.match(r.stdout, /missing: api_key/);
  } finally {
    server.close();
  }
});

test('401 is reported as an auth failure, not as "no memories"', async () => {
  const { server, url } = await startStub({
    ...HEALTHY,
    '/api/v1/memories': { status: 401, body: { code: 'unauthorized' } },
  });
  try {
    const home = fakeHome({ options: { base_url: url, user_id: 'e2e-doctor' } });
    const r = await run(makeEnv({ HOME: home, USERPROFILE: home }));
    assert.equal(r.code, 1);
    assert.match(r.stdout, /FAIL\s+Auth\s+401/);
    assert.match(r.stdout, /SKIP\s+Live read/);
  } finally {
    server.close();
  }
});

test('403 explains the user_id mismatch specifically', async () => {
  const { server, url } = await startStub({
    ...HEALTHY,
    '/api/v1/memories': { status: 403, body: {} },
  });
  try {
    const home = fakeHome({ options: { base_url: url, user_id: 'wrong-user' } });
    const r = await run(makeEnv({ HOME: home, USERPROFILE: home }));
    assert.equal(r.code, 1);
    assert.match(r.stdout, /not minted for user_id "wrong-user"/);
  } finally {
    server.close();
  }
});

test('degraded health names the failing subsystem but auth still runs', async () => {
  const { server, url } = await startStub({
    '/api/health': { body: { status: 'degraded', checks: { memgraph: { ok: true }, embeddings: { ok: false } } } },
    '/api/v1/memories': { body: { items: [], total: 7 } },
  });
  try {
    const home = fakeHome({ options: { base_url: url, user_id: 'e2e-doctor' } });
    const r = await run(makeEnv({ HOME: home, USERPROFILE: home }));
    assert.equal(r.code, 1);
    assert.match(r.stdout, /WARN\s+Server health.*embeddings=FAILING/);
    assert.match(r.stdout, /PASS\s+Auth/, 'later checks must still run');
  } finally {
    server.close();
  }
});

test('unreachable server fails every network check without throwing', async () => {
  const { server, url } = await startStub(HEALTHY);
  server.close();
  const home = fakeHome({ options: { base_url: url, user_id: 'e2e-doctor' } });
  const r = await run(makeEnv({ HOME: home, USERPROFILE: home }));
  assert.equal(r.code, 1);
  assert.match(r.stdout, /FAIL\s+Server health\s+network/);
});

test('hook outcome log is tallied by hook and outcome', async () => {
  const { server, url } = await startStub(HEALTHY);
  try {
    const dir = mkdtempSync(path.join(tmpdir(), 'cortadel-tally-'));
    const logPath = path.join(dir, 'hooks.jsonl');
    writeFileSync(logPath, [
      JSON.stringify({ ts: '2026-08-15T00:00:00Z', hook: 'Stop', outcome: 'no-facts', stored: 0 }),
      JSON.stringify({ ts: '2026-08-15T00:01:00Z', hook: 'Stop', outcome: 'no-facts', stored: 0 }),
      JSON.stringify({ ts: '2026-08-15T00:02:00Z', hook: 'Stop', outcome: 'error', status: 401 }),
      JSON.stringify({ ts: '2026-08-15T00:03:00Z', hook: 'UserPromptSubmit', outcome: 'injected', injected: 3 }),
      '{ this line is truncated garbage',
    ].join('\n') + '\n');

    const home = fakeHome({ options: { base_url: url, user_id: 'e2e-doctor' } });
    const r = await run(makeEnv({ HOME: home, USERPROFILE: home, CORTADEL_HOOKS_LOG: logPath }));
    assert.equal(r.code, 0, r.stdout);
    assert.match(r.stdout, /Stop:no-facts×2/);
    assert.match(r.stdout, /Stop:error×1/);
    assert.match(r.stdout, /UserPromptSubmit:injected×1/);
  } finally {
    server.close();
  }
});

test('CORTADEL_HOOKS_DISABLE is surfaced as a warning', async () => {
  const { server, url } = await startStub(HEALTHY);
  try {
    const home = fakeHome({ options: { base_url: url, user_id: 'e2e-doctor' } });
    const r = await run(makeEnv({ HOME: home, USERPROFILE: home, CORTADEL_HOOKS_DISABLE: '1' }));
    assert.match(r.stdout, /WARN\s+Hooks enabled/);
  } finally {
    server.close();
  }
});
