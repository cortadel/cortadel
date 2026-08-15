// The hooks fail open by design, which on its own makes a healthy install and a
// dead one produce the identical observable: nothing. These tests pin the opt-in
// outcome log (CORTADEL_HOOKS_LOG) that tells them apart, and the recall
// relevance floor (CORTADEL_RECALL_MIN_SCORE).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { mkdtempSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

const STOP = fileURLToPath(new URL('../scripts/stop-capture.mjs', import.meta.url));
const PROMPT = fileURLToPath(new URL('../scripts/user-prompt-submit.mjs', import.meta.url));

const ENV_KEYS = [
  'CORTADEL_URL', 'CORTADEL_API_KEY', 'CORTADEL_USER_ID', 'CORTADEL_CLIENT_NAME',
  'CORTADEL_RECALL_TOPK', 'CORTADEL_MIN_PROMPT_CHARS', 'CORTADEL_RECALL_RERANK',
  'CORTADEL_CAPTURE_MAX_CHARS', 'CORTADEL_HOOKS_DISABLE', 'CORTADEL_HOOKS_LOG',
  'CORTADEL_RECALL_MIN_SCORE',
  'MEMFORGE_URL', 'MEMFORGE_API_KEY', 'MEMFORGE_USER_ID',
  'CLAUDE_PLUGIN_OPTION_BASE_URL', 'CLAUDE_PLUGIN_OPTION_USER_ID',
  'CLAUDE_PLUGIN_OPTION_API_KEY', 'CLAUDE_PLUGIN_OPTION_CLIENT_NAME',
];

function makeEnv(overrides = {}) {
  const env = { ...process.env };
  for (const k of ENV_KEYS) delete env[k];
  return { ...env, ...overrides };
}

function runScript(script, stdinText, env) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [script], { env, stdio: ['pipe', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d) => (stdout += d));
    child.stderr.on('data', (d) => (stderr += d));
    child.on('close', (code) => resolve({ code, stdout, stderr }));
    child.stdin.end(stdinText);
  });
}

function startStub(respond) {
  const server = http.createServer((req, res) => {
    let raw = '';
    req.on('data', (d) => (raw += d));
    req.on('end', () => respond(req, res, raw));
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => resolve({ server, url: `http://127.0.0.1:${server.address().port}` }));
  });
}

const json = (payload, status = 200) => (req, res) => {
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(JSON.stringify(payload));
};

/** A throwaway log path inside a real temp dir (the file itself is created by the hook). */
function tempLogPath() {
  return path.join(mkdtempSync(path.join(tmpdir(), 'cortadel-log-')), 'hooks.jsonl');
}

/** Every JSON line the hook appended, parsed. */
function readLog(p) {
  if (!existsSync(p)) return [];
  return readFileSync(p, 'utf8').split(/\r?\n/).filter(Boolean).map((l) => JSON.parse(l));
}

function tempTranscript(lines) {
  const dir = mkdtempSync(path.join(tmpdir(), 'cortadel-tr-'));
  const p = path.join(dir, 'transcript.jsonl');
  writeFileSync(p, lines.join('\n') + '\n');
  return p;
}

/** A transcript whose single exchange is comfortably over the 80-char floor. */
function realisticTranscript() {
  return tempTranscript([
    JSON.stringify({
      type: 'user',
      uuid: 'u-1',
      message: { role: 'user', content: 'Explain how the bi-temporal invalidation path decides which memory supersedes which.' },
    }),
    JSON.stringify({
      type: 'assistant',
      uuid: 'a-1',
      message: { role: 'assistant', content: [{ type: 'text', text: 'A newer fact invalidates the older one only when the judge marks them contradictory rather than merely similar.' }] },
    }),
  ]);
}

function stopStdin(overrides = {}) {
  return JSON.stringify({
    session_id: 'sess-log-1',
    transcript_path: realisticTranscript(),
    cwd: '/repos/fixture-project',
    hook_event_name: 'Stop',
    stop_hook_active: false,
    ...overrides,
  });
}

const stopEnv = (url, extra = {}) =>
  makeEnv({ CORTADEL_URL: url, CORTADEL_API_KEY: 'test-key', CORTADEL_USER_ID: 'e2e-hooks-log', ...extra });

// ---------------------------------------------------------------- Stop capture

test('log unset → hook stays completely silent and writes no file', async () => {
  const { server, url } = await startStub(json({ results: [{ id: 'X1' }] }));
  const logPath = tempLogPath();
  try {
    const r = await runScript(STOP, stopStdin(), stopEnv(url));
    assert.equal(r.code, 0);
    assert.equal(r.stdout, '');
    assert.equal(existsSync(logPath), false, 'no log file without CORTADEL_HOOKS_LOG');
  } finally {
    server.close();
  }
});

test('facts stored → outcome "stored" with the count', async () => {
  const { server, url } = await startStub(json({ results: [{ id: 'A' }, { id: 'B' }, { id: 'C' }] }));
  const logPath = tempLogPath();
  try {
    const r = await runScript(STOP, stopStdin(), stopEnv(url, { CORTADEL_HOOKS_LOG: logPath }));
    assert.equal(r.code, 0);
    assert.equal(r.stdout, '', 'the log must never leak onto stdout');
    const [e] = readLog(logPath);
    assert.equal(e.hook, 'Stop');
    assert.equal(e.outcome, 'stored');
    assert.equal(e.stored, 3);
    assert.ok(typeof e.ms === 'number');
    assert.ok(typeof e.ts === 'string');
  } finally {
    server.close();
  }
});

test('no_facts_extracted → outcome "no-facts", NOT an error', async () => {
  const { server, url } = await startStub(json({ no_facts_extracted: true }));
  const logPath = tempLogPath();
  try {
    await runScript(STOP, stopStdin(), stopEnv(url, { CORTADEL_HOOKS_LOG: logPath }));
    const [e] = readLog(logPath);
    assert.equal(e.outcome, 'no-facts');
    assert.equal(e.stored, 0);
  } finally {
    server.close();
  }
});

test('server 401 → outcome "error" carrying the status (the case that used to be invisible)', async () => {
  const { server, url } = await startStub(json({ code: 'unauthorized' }, 401));
  const logPath = tempLogPath();
  try {
    const r = await runScript(STOP, stopStdin(), stopEnv(url, { CORTADEL_HOOKS_LOG: logPath }));
    assert.equal(r.code, 0, 'still fails open');
    assert.equal(r.stdout, '');
    const [e] = readLog(logPath);
    assert.equal(e.outcome, 'error');
    assert.equal(e.error, 'http');
    assert.equal(e.status, 401);
  } finally {
    server.close();
  }
});

test('unreachable server → outcome "error" with error "network"', async () => {
  const { server, url } = await startStub(json({}));
  server.close();
  const logPath = tempLogPath();
  const r = await runScript(STOP, stopStdin(), stopEnv(url, { CORTADEL_HOOKS_LOG: logPath }));
  assert.equal(r.code, 0);
  const [e] = readLog(logPath);
  assert.equal(e.outcome, 'error');
  assert.equal(e.error, 'network');
});

test('trivial exchange → skip reason "trivial-exchange" with both char counts', async () => {
  const { server, url } = await startStub(json({ results: [] }));
  const logPath = tempLogPath();
  const transcript = tempTranscript([
    JSON.stringify({ type: 'user', uuid: 'u', message: { role: 'user', content: 'hi' } }),
    JSON.stringify({ type: 'assistant', uuid: 'a', message: { role: 'assistant', content: [{ type: 'text', text: 'hello' }] } }),
  ]);
  try {
    await runScript(STOP, stopStdin({ transcript_path: transcript }), stopEnv(url, { CORTADEL_HOOKS_LOG: logPath }));
    const [e] = readLog(logPath);
    assert.equal(e.outcome, 'skip');
    assert.equal(e.reason, 'trivial-exchange');
    assert.equal(e.userChars, 2);
    assert.equal(e.assistantChars, 5);
  } finally {
    server.close();
  }
});

test('recursion guard and missing config are distinguishable in the log', async () => {
  const { server, url } = await startStub(json({ results: [] }));
  try {
    const recursion = tempLogPath();
    await runScript(STOP, stopStdin({ stop_hook_active: true }), stopEnv(url, { CORTADEL_HOOKS_LOG: recursion }));
    assert.equal(readLog(recursion)[0].reason, 'recursion-guard');

    const noConfig = tempLogPath();
    await runScript(STOP, stopStdin(), makeEnv({ CORTADEL_URL: url, CORTADEL_HOOKS_LOG: noConfig }));
    assert.equal(readLog(noConfig)[0].reason, 'no-config');

    const disabled = tempLogPath();
    await runScript(STOP, stopStdin(), stopEnv(url, { CORTADEL_HOOKS_LOG: disabled, CORTADEL_HOOKS_DISABLE: '1' }));
    assert.equal(readLog(disabled)[0].reason, 'hooks-disabled');
  } finally {
    server.close();
  }
});

test('unwritable log path → hook still succeeds silently', async () => {
  const { server, url } = await startStub(json({ results: [{ id: 'A' }] }));
  try {
    const bogus = path.join(tmpdir(), 'cortadel-does-not-exist-' + process.pid, 'nested', 'x.jsonl');
    const r = await runScript(STOP, stopStdin(), stopEnv(url, { CORTADEL_HOOKS_LOG: bogus }));
    assert.equal(r.code, 0);
    assert.equal(r.stdout, '');
  } finally {
    server.close();
  }
});

// ------------------------------------------------------- UserPromptSubmit recall

const promptStdin = (prompt) => JSON.stringify({ prompt, hook_event_name: 'UserPromptSubmit' });

const searchResults = (...scores) => ({
  results: scores.map((rrf_score, i) => ({
    id: 'M' + i,
    content: 'memory number ' + i,
    rrf_score,
    created_at: '2026-08-15T10:00:00Z',
  })),
});

test('injected recall is logged with counts', async () => {
  const { server, url } = await startStub(json(searchResults(0.7, 0.5)));
  const logPath = tempLogPath();
  try {
    const r = await runScript(PROMPT, promptStdin('how does invalidation work in this engine?'), stopEnv(url, { CORTADEL_HOOKS_LOG: logPath }));
    assert.match(r.stdout, /Relevant Cortadel memories/);
    const [e] = readLog(logPath);
    assert.equal(e.outcome, 'injected');
    assert.equal(e.injected, 2);
    assert.equal(e.returned, 2);
    assert.equal(e.belowFloor, 0);
  } finally {
    server.close();
  }
});

test('relevance floor drops weak matches from the injected block', async () => {
  const { server, url } = await startStub(json(searchResults(0.71, 0.33, 0.30)));
  const logPath = tempLogPath();
  try {
    const r = await runScript(
      PROMPT,
      promptStdin('how does invalidation work in this engine?'),
      stopEnv(url, { CORTADEL_HOOKS_LOG: logPath, CORTADEL_RECALL_MIN_SCORE: '0.4' })
    );
    assert.match(r.stdout, /memory number 0/);
    assert.doesNotMatch(r.stdout, /memory number 1/, 'below-floor memory must not be injected');
    assert.doesNotMatch(r.stdout, /memory number 2/);
    const [e] = readLog(logPath);
    assert.equal(e.injected, 1);
    assert.equal(e.belowFloor, 2);
  } finally {
    server.close();
  }
});

test('everything below the floor → nothing injected, logged as no-results', async () => {
  const { server, url } = await startStub(json(searchResults(0.2, 0.1)));
  const logPath = tempLogPath();
  try {
    const r = await runScript(
      PROMPT,
      promptStdin('a prompt with no relevant memories at all'),
      stopEnv(url, { CORTADEL_HOOKS_LOG: logPath, CORTADEL_RECALL_MIN_SCORE: '0.4' })
    );
    assert.equal(r.stdout, '');
    const [e] = readLog(logPath);
    assert.equal(e.outcome, 'no-results');
    assert.equal(e.belowFloor, 2);
  } finally {
    server.close();
  }
});

test('default (no floor set) injects weak matches exactly as before', async () => {
  const { server, url } = await startStub(json(searchResults(0.2, 0.1)));
  try {
    const r = await runScript(PROMPT, promptStdin('a prompt with only weak memories'), stopEnv(url));
    assert.match(r.stdout, /memory number 0/);
    assert.match(r.stdout, /memory number 1/);
  } finally {
    server.close();
  }
});

test('an unscored result is never dropped by the floor', async () => {
  const { server, url } = await startStub(
    json({ results: [{ id: 'U', content: 'unscored memory', created_at: '2026-08-15T10:00:00Z' }] })
  );
  try {
    const r = await runScript(
      PROMPT,
      promptStdin('a prompt whose results carry no score'),
      stopEnv(url, { CORTADEL_RECALL_MIN_SCORE: '0.9' })
    );
    assert.match(r.stdout, /unscored memory/);
  } finally {
    server.close();
  }
});

test('search failure is logged as an error rather than silently looking like "no memories"', async () => {
  const { server, url } = await startStub(json({ code: 'boom' }, 500));
  const logPath = tempLogPath();
  try {
    const r = await runScript(PROMPT, promptStdin('any sufficiently long prompt here'), stopEnv(url, { CORTADEL_HOOKS_LOG: logPath }));
    assert.equal(r.code, 0);
    assert.equal(r.stdout, '');
    const [e] = readLog(logPath);
    assert.equal(e.outcome, 'error');
    assert.equal(e.status, 500);
  } finally {
    server.close();
  }
});

test('short prompts and slash commands log distinct skip reasons', async () => {
  const { server, url } = await startStub(json(searchResults(0.9)));
  try {
    const short = tempLogPath();
    await runScript(PROMPT, promptStdin('hi'), stopEnv(url, { CORTADEL_HOOKS_LOG: short }));
    assert.equal(readLog(short)[0].reason, 'prompt-too-short');

    const slash = tempLogPath();
    await runScript(PROMPT, promptStdin('/doctor run every check'), stopEnv(url, { CORTADEL_HOOKS_LOG: slash }));
    assert.equal(readLog(slash)[0].reason, 'command-prompt');
  } finally {
    server.close();
  }
});
