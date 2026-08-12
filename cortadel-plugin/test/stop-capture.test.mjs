import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

const SCRIPT = fileURLToPath(new URL('../scripts/stop-capture.mjs', import.meta.url));
const FIXTURE = fileURLToPath(new URL('./fixtures/transcript.jsonl', import.meta.url));

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

const okResponder = (req, res) => {
  res.writeHead(200, { 'content-type': 'application/json' });
  res.end(JSON.stringify({ results: [{ id: 'X1', memory: 'stored' }] }));
};

// Forward slashes so path.basename yields the same result on Windows and Linux.
const CWD = '/repos/fixture-project';

function stdinFor(overrides = {}) {
  return JSON.stringify({
    session_id: 'sess-stop-1',
    transcript_path: FIXTURE,
    cwd: CWD,
    hook_event_name: 'Stop',
    stop_hook_active: false,
    ...overrides,
  });
}

/** Write a throwaway transcript and return its path. */
function tempTranscript(lines) {
  const dir = mkdtempSync(path.join(tmpdir(), 'cortadel-stop-'));
  const p = path.join(dir, 'transcript.jsonl');
  writeFileSync(p, lines.join('\n') + '\n');
  return p;
}

test('missing config → exit 0, empty stdout, no request', async () => {
  const { server, requests, url } = await startStub(okResponder);
  try {
    // CORTADEL_API_KEY / USER_ID deliberately absent
    const env = makeEnv({ CORTADEL_URL: url });
    const r = await runScript(stdinFor(), env);
    assert.equal(r.code, 0);
    assert.equal(r.stdout, '');
    assert.equal(requests.length, 0);
  } finally {
    server.close();
  }
});

test('only legacy MEMFORGE_* vars set → still exit 0 empty stdout, no request, but stderr names both vars', async () => {
  const { server, requests, url } = await startStub(okResponder);
  try {
    const env = makeEnv({
      MEMFORGE_URL: url,
      MEMFORGE_API_KEY: 'legacy-key',
      MEMFORGE_USER_ID: 'legacy-user',
    });
    const r = await runScript(stdinFor(), env);
    assert.equal(r.code, 0);
    assert.equal(r.stdout, '');
    assert.equal(requests.length, 0, 'no fallback: the legacy URL must never be dialed');
    assert.match(r.stderr, /MEMFORGE_URL/);
    assert.match(r.stderr, /CORTADEL_URL/);
  } finally {
    server.close();
  }
});

test('stop_hook_active true → exit 0, empty stdout, no request (recursion guard)', async () => {
  const { server, requests, url } = await startStub(okResponder);
  try {
    const r = await runScript(stdinFor({ stop_hook_active: true }), requiredEnv(url));
    assert.equal(r.code, 0);
    assert.equal(r.stdout, '');
    assert.equal(requests.length, 0);
  } finally {
    server.close();
  }
});

test('invalid stdin JSON → exit 0, empty stdout, no request', async () => {
  const { server, requests, url } = await startStub(okResponder);
  try {
    const r = await runScript('this is not json', requiredEnv(url));
    assert.equal(r.code, 0);
    assert.equal(r.stdout, '');
    assert.equal(requests.length, 0);
  } finally {
    server.close();
  }
});

test('missing transcript file → exit 0, empty stdout, no request', async () => {
  const { server, requests, url } = await startStub(okResponder);
  try {
    const r = await runScript(
      stdinFor({ transcript_path: path.join(tmpdir(), 'cortadel-nope', 'missing.jsonl') }),
      requiredEnv(url)
    );
    assert.equal(r.code, 0);
    assert.equal(r.stdout, '');
    assert.equal(requests.length, 0);
  } finally {
    server.close();
  }
});

test('stdin without transcript_path → exit 0, empty stdout, no request', async () => {
  const { server, requests, url } = await startStub(okResponder);
  try {
    const r = await runScript(
      JSON.stringify({ session_id: 's1', cwd: tmpdir(), hook_event_name: 'Stop', stop_hook_active: false }),
      requiredEnv(url)
    );
    assert.equal(r.code, 0);
    assert.equal(r.stdout, '');
    assert.equal(requests.length, 0);
  } finally {
    server.close();
  }
});

test('happy path → POST from-conversation with LAST exchange only; malformed lines tolerated; never any stdout', async () => {
  const { server, requests, url } = await startStub(okResponder);
  try {
    const r = await runScript(stdinFor(), requiredEnv(url));
    assert.equal(r.code, 0);
    assert.equal(r.stdout, '', 'Stop hook must never write to stdout');

    assert.equal(requests.length, 1);
    const req = requests[0];
    assert.equal(req.method, 'POST');
    assert.equal(req.auth, 'Bearer test-key');
    const u = new URL(req.url, 'http://x');
    assert.equal(u.pathname, '/api/v1/memories/from-conversation');

    const body = req.body;
    assert.equal(body.user_id, 'test-user');
    assert.equal(body.session_id, 'sess-stop-1');
    assert.equal(body.project, 'fixture-project', 'project must be basename(cwd)');
    assert.deepEqual(body.tags, ['claude-code']);

    assert.equal(body.messages.length, 2, 'exactly one user+assistant pair');
    assert.equal(body.messages[0].role, 'user');
    assert.equal(body.messages[1].role, 'assistant');
    assert.ok(body.messages[0].content.startsWith('FINAL-USER:'), `wrong user turn: ${body.messages[0].content}`);
    assert.ok(
      body.messages[1].content.startsWith('FINAL-ASSISTANT:'),
      `wrong assistant turn: ${body.messages[1].content}`
    );
    // Turn anchors: uuids of the SELECTED lines + the transcript path.
    assert.equal(body.transcript_path, FIXTURE, 'transcript_path must be forwarded');
    assert.equal(body.messages[0].uuid, '4d444444-4444-4444-8444-444444444444', 'user uuid must be FINAL-USER line uuid');
    assert.equal(body.messages[1].uuid, '6f666666-6666-4666-8666-666666666666', 'assistant uuid must be FINAL-ASSISTANT line uuid');
    // Earlier exchange, tool traffic and meta lines must not leak into the capture.
    const flat = JSON.stringify(body.messages);
    assert.ok(!flat.includes('EARLY-USER'), 'earlier user turn leaked');
    assert.ok(!flat.includes('EARLY-ASSISTANT'), 'earlier assistant turn leaked');
    assert.ok(!flat.includes('tool_result'), 'tool_result leaked');
    assert.ok(!flat.includes('docker ps'), 'tool_use input leaked');
    assert.ok(!flat.includes('META-USER'), 'isMeta user line captured instead of the human turn');
  } finally {
    server.close();
  }
});

test('tool-only transcript → exit 0, empty stdout, no request', async () => {
  const { server, requests, url } = await startStub(okResponder);
  try {
    const p = tempTranscript([
      '{"type":"assistant","message":{"role":"assistant","content":[{"type":"tool_use","id":"t1","name":"Bash","input":{"command":"ls"}}]}}',
      '{"type":"user","message":{"role":"user","content":[{"type":"tool_result","tool_use_id":"t1","content":"files"}]}}',
      '{"type":"assistant","message":{"role":"assistant","content":[{"type":"tool_use","id":"t2","name":"Bash","input":{"command":"pwd"}}]}}',
    ]);
    const r = await runScript(stdinFor({ transcript_path: p }), requiredEnv(url));
    assert.equal(r.code, 0);
    assert.equal(r.stdout, '');
    assert.equal(requests.length, 0);
  } finally {
    server.close();
  }
});

test('trivial exchange (combined < 80 chars) → exit 0, empty stdout, no request', async () => {
  const { server, requests, url } = await startStub(okResponder);
  try {
    const p = tempTranscript([
      '{"type":"user","message":{"role":"user","content":"hi"}}',
      '{"type":"assistant","message":{"role":"assistant","content":[{"type":"text","text":"hello there"}]}}',
    ]);
    const r = await runScript(stdinFor({ transcript_path: p }), requiredEnv(url));
    assert.equal(r.code, 0);
    assert.equal(r.stdout, '');
    assert.equal(requests.length, 0);
  } finally {
    server.close();
  }
});

test('uuid-less transcript → request sent, uuid fields omitted, transcript_path still present', async () => {
  const { server, requests, url } = await startStub(okResponder);
  try {
    const p = tempTranscript([
      '{"type":"user","message":{"role":"user","content":"SYNTH-USER: please explain in detail how the capture hook selects the final exchange."}}',
      '{"type":"assistant","message":{"role":"assistant","content":[{"type":"text","text":"SYNTH-ASSISTANT: it scans backward for the last text-bearing assistant and user turns."}]}}',
    ]);
    const r = await runScript(stdinFor({ transcript_path: p }), requiredEnv(url));
    assert.equal(r.code, 0);
    assert.equal(r.stdout, '');
    assert.equal(requests.length, 1);
    const body = requests[0].body;
    assert.equal(body.transcript_path, p, 'transcript_path must be forwarded even without uuids');
    assert.ok(!('uuid' in body.messages[0]), 'user uuid must be omitted when absent');
    assert.ok(!('uuid' in body.messages[1]), 'assistant uuid must be omitted when absent');
  } finally {
    server.close();
  }
});

test('non-human user turn (origin.kind) after the human one → human turn wins', async () => {
  const { server, requests, url } = await startStub(okResponder);
  try {
    const p = tempTranscript([
      '{"type":"user","uuid":"aaaa1111-1111-4111-8111-111111111111","origin":{"kind":"human"},"message":{"role":"user","content":"HUMAN-USER: walk me through the deploy health gate changes we shipped this week."}}',
      '{"type":"user","uuid":"bbbb2222-2222-4222-8222-222222222222","origin":{"kind":"task-notification"},"message":{"role":"user","content":"TASK-NOTIFY: a background task finished; this synthetic prompt is not from the human."}}',
      '{"type":"assistant","uuid":"cccc3333-3333-4333-8333-333333333333","message":{"role":"assistant","content":[{"type":"text","text":"ANSWER: the health gate now checks pull throughput before declaring success."}]}}',
    ]);
    const r = await runScript(stdinFor({ transcript_path: p }), requiredEnv(url));
    assert.equal(r.code, 0);
    assert.equal(r.stdout, '');
    assert.equal(requests.length, 1);
    const body = requests[0].body;
    assert.ok(body.messages[0].content.startsWith('HUMAN-USER:'), `non-human turn captured: ${body.messages[0].content}`);
    assert.equal(body.messages[0].uuid, 'aaaa1111-1111-4111-8111-111111111111');
    assert.equal(body.messages[1].uuid, 'cccc3333-3333-4333-8333-333333333333');
  } finally {
    server.close();
  }
});

test('only non-human user turns exist → falls back to the last one (still captured)', async () => {
  const { server, requests, url } = await startStub(okResponder);
  try {
    const p = tempTranscript([
      '{"type":"user","uuid":"dddd4444-4444-4444-8444-444444444444","isMeta":true,"message":{"role":"user","content":"META-ONLY-USER: injected context describing repository conventions and current task state."}}',
      '{"type":"assistant","uuid":"eeee5555-5555-4555-8555-555555555555","message":{"role":"assistant","content":[{"type":"text","text":"ANSWER: acknowledged; proceeding with the conventions described in the injected context."}]}}',
    ]);
    const r = await runScript(stdinFor({ transcript_path: p }), requiredEnv(url));
    assert.equal(r.code, 0);
    assert.equal(r.stdout, '');
    assert.equal(requests.length, 1);
    const body = requests[0].body;
    assert.ok(body.messages[0].content.startsWith('META-ONLY-USER:'), 'fallback to non-human turn must still capture');
    assert.equal(body.messages[0].uuid, 'dddd4444-4444-4444-8444-444444444444');
  } finally {
    server.close();
  }
});

test('server 500 → exit 0, empty stdout (fail open)', async () => {
  const { server, url } = await startStub((req, res) => {
    res.writeHead(500, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ status: 500 }));
  });
  try {
    const r = await runScript(stdinFor(), requiredEnv(url));
    assert.equal(r.code, 0);
    assert.equal(r.stdout, '');
  } finally {
    server.close();
  }
});
