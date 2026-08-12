// Cross-checks packaging/plugin.metadata.json's four userConfig option keys against
// cortadel-plugin/scripts/lib.mjs's actual cfg() behavior. Unlike the hardcoded
// CLAUDE_PLUGIN_OPTION_* env var names in cortadel-plugin/test/lib.test.mjs (which pin
// today's known-good values), this file DERIVES the expected env var name from
// plugin.metadata.json itself — so if a userConfig option is ever renamed in the metadata without
// updating lib.mjs's mapping, this test catches the drift even though the hand-written names in
// lib.test.mjs would not. The broader "CLAUDE_PLUGIN_OPTION_* wins / CORTADEL_* alone still
// works" behavioral suite lives in cortadel-plugin/test/lib.test.mjs — this file is the
// packaging-side half of that guarantee, not a duplicate of it.
import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { cfg } from '../../cortadel-plugin/scripts/lib.mjs';
import { METADATA_PATH } from '../generate.mjs';

const meta = JSON.parse(readFileSync(METADATA_PATH, 'utf8'));

// userConfig key -> cfg() result property. Hand-maintained on purpose: this mapping IS the
// contract between packaging/plugin.metadata.json and lib.mjs; a test asserting it stays correct
// only by re-deriving it from lib.mjs would not be testing anything.
const OPTION_TO_CFG_PROPERTY = {
  base_url: 'url',
  user_id: 'userId',
  api_key: 'apiKey',
  client_name: 'clientName',
};

test('every declared userConfig option has a known cfg() property mapping', () => {
  for (const key of Object.keys(meta.userConfig)) {
    assert.ok(key in OPTION_TO_CFG_PROPERTY, `userConfig option "${key}" has no cfg() mapping in this test`);
  }
  assert.deepEqual(Object.keys(OPTION_TO_CFG_PROPERTY).sort(), Object.keys(meta.userConfig).sort());
});

const ENV_KEYS = [
  'CORTADEL_URL',
  'CORTADEL_API_KEY',
  'CORTADEL_USER_ID',
  'CORTADEL_CLIENT_NAME',
  'CORTADEL_HOOKS_DISABLE',
  'MEMFORGE_URL',
  'MEMFORGE_API_KEY',
  'MEMFORGE_USER_ID',
  ...Object.keys(meta.userConfig).map((k) => `CLAUDE_PLUGIN_OPTION_${k.toUpperCase()}`),
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

function setRequiredViaCortadel() {
  process.env.CORTADEL_URL = 'http://127.0.0.1:9';
  process.env.CORTADEL_API_KEY = 'test-key';
  process.env.CORTADEL_USER_ID = 'test-user';
}

test('CLAUDE_PLUGIN_OPTION_<KEY> (derived from metadata.json) feeds every required option into cfg()', () => {
  for (const key of ['base_url', 'user_id', 'api_key']) {
    process.env[`CLAUDE_PLUGIN_OPTION_${key.toUpperCase()}`] = `value-for-${key}`;
  }
  const c = cfg();
  assert.ok(c, 'the three required options via CLAUDE_PLUGIN_OPTION_* must be enough to configure the plugin');
  assert.equal(c[OPTION_TO_CFG_PROPERTY.base_url], 'value-for-base_url');
  assert.equal(c[OPTION_TO_CFG_PROPERTY.user_id], 'value-for-user_id');
  assert.equal(c[OPTION_TO_CFG_PROPERTY.api_key], 'value-for-api_key');
});

test('CORTADEL_* alone (no CLAUDE_PLUGIN_OPTION_*) still fully configures the plugin', () => {
  setRequiredViaCortadel();
  const c = cfg();
  assert.ok(c);
  assert.equal(c.url, 'http://127.0.0.1:9');
  assert.equal(c.apiKey, 'test-key');
  assert.equal(c.userId, 'test-user');
});

test('CLAUDE_PLUGIN_OPTION_BASE_URL wins over CORTADEL_URL when both are set', () => {
  setRequiredViaCortadel();
  process.env.CLAUDE_PLUGIN_OPTION_BASE_URL = 'http://127.0.0.1:4242';
  const c = cfg();
  assert.equal(c.url, 'http://127.0.0.1:4242');
});

test('client_name defaults to plugin.metadata.json\'s documented default when nothing is set', () => {
  setRequiredViaCortadel();
  const c = cfg();
  assert.equal(c.clientName, meta.userConfig.client_name.default);
});

test('client_name reaches cfg() via CLAUDE_PLUGIN_OPTION_CLIENT_NAME, winning over CORTADEL_CLIENT_NAME', () => {
  setRequiredViaCortadel();
  process.env.CORTADEL_CLIENT_NAME = 'dev-flow';
  process.env.CLAUDE_PLUGIN_OPTION_CLIENT_NAME = 'installed-plugin';
  const c = cfg();
  assert.equal(c.clientName, 'installed-plugin');
});
