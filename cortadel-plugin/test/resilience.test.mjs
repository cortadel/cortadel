// Failure modes that only show up on a long-lived or misbehaving install:
// a server that stalls mid-body, a log left enabled for months, and a diagnostic
// asked to read that log.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { mkdtempSync, writeFileSync, readFileSync, existsSync, statSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { apiDetailed, logEvent } from '../scripts/lib.mjs';

const DOCTOR = fileURLToPath(new URL('../scripts/doctor.mjs', import.meta.url));

function startServer(handler) {
  const server = http.createServer(handler);
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => resolve({ server, url: `http://127.0.0.1:${server.address().port}` }));
  });
}

// An explicit test timeout matters here: before the fix this case did not fail,
// it HUNG. Without it a regression would stall the suite rather than report.
test('a server that stalls mid-body aborts on the timeout instead of hanging forever', { timeout: 15000 }, async () => {
  // Headers and a partial body, then silence — the response never completes.
  const { server, url } = await startServer((req, res) => {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.write('{"results":[');
    // deliberately never res.end()
  });
  try {
    const started = Date.now();
    const r = await apiDetailed({ url, apiKey: 'k', userId: 'u' }, 'GET', '/api/health', { timeoutMs: 400 });
    const elapsed = Date.now() - started;
    assert.equal(r.ok, false);
    assert.equal(r.error, 'abort', 'a stalled body read must time out, not resolve as a parse error');
    assert.equal(r.status, 200, 'the status seen before the stall is still useful diagnostic detail');
    assert.ok(elapsed < 3000, `should abort near the 400ms budget, took ${elapsed}ms`);
  } finally {
    server.close();
    server.closeAllConnections?.();
  }
});

test('a non-JSON 200 body is reported as parse, not abort', async () => {
  const { server, url } = await startServer((req, res) => {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end('this is not json');
  });
  try {
    const r = await apiDetailed({ url, apiKey: 'k', userId: 'u' }, 'GET', '/api/health', { timeoutMs: 5000 });
    assert.equal(r.ok, false);
    assert.equal(r.error, 'parse');
    assert.equal(r.status, 200);
  } finally {
    server.close();
  }
});

test('a malformed base_url fails closed rather than throwing', async () => {
  const r = await apiDetailed({ url: 'not-a-url', apiKey: 'k', userId: 'u' }, 'GET', '/api/health', { timeoutMs: 500 });
  assert.equal(r.ok, false);
  assert.equal(r.error, 'network');
});

test('the outcome log rotates instead of growing without bound', async () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'cortadel-rot-'));
  const logPath = path.join(dir, 'hooks.jsonl');
  const prev = process.env.CORTADEL_HOOKS_LOG;
  process.env.CORTADEL_HOOKS_LOG = logPath;
  try {
    // Just over the 5 MiB rotation threshold.
    writeFileSync(logPath, 'x'.repeat(5 * 1024 * 1024 + 10) + '\n');
    logEvent('Stop', 'stored', { stored: 1 });

    assert.ok(existsSync(logPath + '.1'), 'the oversized log is rotated aside');
    const fresh = readFileSync(logPath, 'utf8');
    assert.ok(statSync(logPath).size < 1024, 'the live log restarts small');
    assert.equal(JSON.parse(fresh.trim()).outcome, 'stored');

    // A second rotation must replace the previous .1 rather than fail (Windows).
    writeFileSync(logPath, 'y'.repeat(5 * 1024 * 1024 + 10) + '\n');
    logEvent('Stop', 'no-facts', { stored: 0 });
    assert.equal(JSON.parse(readFileSync(logPath, 'utf8').trim()).outcome, 'no-facts');
  } finally {
    if (prev === undefined) delete process.env.CORTADEL_HOOKS_LOG;
    else process.env.CORTADEL_HOOKS_LOG = prev;
  }
});

test('logEvent never throws when the log path is a directory', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'cortadel-dirlog-'));
  const prev = process.env.CORTADEL_HOOKS_LOG;
  process.env.CORTADEL_HOOKS_LOG = dir; // a directory, not a file
  try {
    assert.doesNotThrow(() => logEvent('Stop', 'stored', { stored: 1 }));
  } finally {
    if (prev === undefined) delete process.env.CORTADEL_HOOKS_LOG;
    else process.env.CORTADEL_HOOKS_LOG = prev;
  }
});

test('doctor tails a large log cheaply and still reports the newest entries', async () => {
  const { server, url } = await startServer((req, res) => {
    const route = req.url.split('?')[0];
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify(route === '/api/health' ? { status: 'ok', checks: {} } : { items: [], total: 3 }));
  });
  try {
    const dir = mkdtempSync(path.join(tmpdir(), 'cortadel-biglog-'));
    const logPath = path.join(dir, 'hooks.jsonl');
    // ~2 MiB of history whose LAST lines are the ones that matter.
    const filler = Array.from({ length: 20000 }, (_, i) =>
      JSON.stringify({ ts: '2026-01-01T00:00:00Z', hook: 'UserPromptSubmit', outcome: 'injected', injected: 1, pad: 'p'.repeat(80), i })
    );
    filler.push(JSON.stringify({ ts: '2026-08-15T00:00:00Z', hook: 'Stop', outcome: 'error', status: 401 }));
    writeFileSync(logPath, filler.join('\n') + '\n');
    assert.ok(statSync(logPath).size > 1024 * 1024, 'fixture really is large');

    const home = mkdtempSync(path.join(tmpdir(), 'cortadel-home-'));
    mkdirSync(path.join(home, '.claude'), { recursive: true });
    writeFileSync(
      path.join(home, '.claude', 'settings.json'),
      JSON.stringify({ pluginConfigs: { 'cortadel-memory@m': { options: { base_url: url, user_id: 'e2e-doctor' } } } })
    );
    writeFileSync(
      path.join(home, '.claude', '.credentials.json'),
      JSON.stringify({ pluginSecrets: { 'cortadel-memory@m': { api_key: 'k' } } })
    );

    const started = Date.now();
    const r = await new Promise((resolve) => {
      const child = spawn(process.execPath, [DOCTOR], {
        env: { ...process.env, HOME: home, USERPROFILE: home, CORTADEL_HOOKS_LOG: logPath },
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      let stdout = '';
      child.stdout.on('data', (d) => (stdout += d));
      child.on('close', (code) => resolve({ code, stdout }));
    });
    assert.equal(r.code, 0, r.stdout);
    assert.match(r.stdout, /Stop:error×1/, 'the newest entry survives the tail');
    assert.ok(Date.now() - started < 15000, 'must not slurp the whole file');
  } finally {
    server.close();
  }
});
