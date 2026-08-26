// Source-level checks over packaging/plugin.metadata.json — the single hand-written place for
// plugin identity, the four userConfig options, and the MCP URL template (see
// packaging/generate.mjs's header). These checks are reimplemented independently of
// generate.mjs's own loadMetadata() validation (rather than just calling it) so a bug in the
// generator's validation logic can't mask a problem with the data it is supposed to catch.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const METADATA_PATH = fileURLToPath(new URL('../plugin.metadata.json', import.meta.url));
const meta = JSON.parse(readFileSync(METADATA_PATH, 'utf8'));

const OPTION_KEY_RE = /^[A-Za-z_]\w*$/;
const ALLOWED_OPTION_KEYS = new Set([
  'type',
  'title',
  'description',
  'default',
  'required',
  'sensitive',
  'multiple',
  'min',
  'max',
]);
const REQUIRED_OPTION_KEYS = ['type', 'title', 'description'];

test('plugin.metadata.json declares exactly the four documented userConfig options', () => {
  assert.deepEqual(
    Object.keys(meta.userConfig).sort(),
    ['api_key', 'base_url', 'client_name', 'user_id'],
    'the design specifies base_url, user_id, api_key, client_name — no more, no fewer'
  );
});

test('every userConfig key matches ^[A-Za-z_]\\w*$', () => {
  for (const key of Object.keys(meta.userConfig)) {
    assert.match(key, OPTION_KEY_RE, `userConfig key "${key}" is not a valid identifier`);
  }
});

test('every userConfig option carries exactly type/title/description plus only allowed optional keys', () => {
  for (const [key, opt] of Object.entries(meta.userConfig)) {
    for (const required of REQUIRED_OPTION_KEYS) {
      assert.ok(required in opt, `userConfig.${key} is missing required "${required}"`);
      assert.equal(typeof opt[required], 'string', `userConfig.${key}.${required} must be a string`);
      assert.ok(opt[required].length > 0, `userConfig.${key}.${required} must not be empty`);
    }
    for (const k of Object.keys(opt)) {
      assert.ok(ALLOWED_OPTION_KEYS.has(k), `userConfig.${key} has a disallowed key "${k}"`);
    }
  }
});

test('base_url, user_id, api_key are required; client_name is optional with a default', () => {
  assert.equal(meta.userConfig.base_url.required, true);
  assert.equal(meta.userConfig.user_id.required, true);
  assert.equal(meta.userConfig.api_key.required, true);
  assert.equal(meta.userConfig.client_name.required, false);
  assert.equal(typeof meta.userConfig.client_name.default, 'string');
});

test('api_key is sensitive', () => {
  assert.equal(meta.userConfig.api_key.sensitive, true);
});

test('base_url default has no trailing slash', () => {
  const dflt = meta.userConfig.base_url.default;
  assert.equal(typeof dflt, 'string');
  assert.ok(!dflt.endsWith('/'), `base_url default "${dflt}" must not have a trailing slash`);
});

test('mcp.urlTemplate references only declared userConfig option keys', () => {
  const declared = new Set(Object.keys(meta.userConfig));
  const placeholderRe = /\$\{user_config\.([A-Za-z_]\w*)\}/g;
  for (const [, key] of meta.mcp.urlTemplate.matchAll(placeholderRe)) {
    assert.ok(declared.has(key), `mcp.urlTemplate references undeclared user_config key "${key}"`);
  }
});

test('mcp.urlTemplate is the literal hosted endpoint', () => {
  assert.equal(meta.mcp.urlTemplate, 'https://app.cortadel.ai/mcp/claude');
});

// THE load-bearing rule. Claude Desktop and claude.ai consume the same plugin.json as Claude Code,
// but they perform NO ${user_config.*} substitution: their manifest reader copies mcpServers[].url
// verbatim into the connector dialog, which validates it with a bare startsWith("https"). A url
// beginning with '${' therefore fails as "URL must start with 'https'" — which is exactly the bug
// users hit. Any placeholder ANYWHERE in the url reintroduces it, so the url must stay fully literal.
test('mcp.urlTemplate contains no placeholder of any kind', () => {
  assert.ok(
    !meta.mcp.urlTemplate.includes('${'),
    'the MCP url must be literal: Claude Desktop / claude.ai copy it verbatim without substituting ' +
      'plugin options, so any ${...} makes the connector fail its https check'
  );
});

test('mcp.urlTemplate starts with https:// so every Claude surface accepts it', () => {
  assert.ok(meta.mcp.urlTemplate.startsWith('https://'), 'connector dialogs require an https URL');
});

// The rules below are the reason this file exists. The previous revision asserted only the
// exact string above, so when the server dropped the user-id path segment (2026-08-21) the
// literal and the assertion were simply wrong together and nothing failed. These assert the
// INVARIANT instead: no user identity in the URL, exactly one segment after /mcp/.
// (The url later became fully literal — see the placeholder rule above — but these still hold.)
test('mcp.urlTemplate never carries a user identity segment', () => {
  assert.ok(
    !/user_id/.test(meta.mcp.urlTemplate),
    'the MCP URL must not reference user_id — the server resolves identity from the Bearer ' +
      'key, and a user id in the path leaks into access, proxy and browser-history logs'
  );
});

test('mcp.urlTemplate has exactly one path segment after /mcp/', () => {
  const tail = meta.mcp.urlTemplate.split('/mcp/')[1];
  assert.ok(tail !== undefined, 'urlTemplate must contain a /mcp/ path');
  assert.equal(
    tail.split('/').length,
    1,
    `expected a single {clientName} segment after /mcp/, got "${tail}"`
  );
});

test('top-level identity fields are all non-empty strings', () => {
  for (const field of ['name', 'displayName', 'version', 'description', 'homepage', 'repository', 'license', 'category']) {
    assert.equal(typeof meta[field], 'string', `${field} must be a string`);
    assert.ok(meta[field].length > 0, `${field} must not be empty`);
  }
  assert.ok(Array.isArray(meta.keywords) && meta.keywords.length > 0, 'keywords must be a non-empty array');
  assert.equal(typeof meta.author, 'object');
  assert.equal(typeof meta.author.name, 'string');
});

test('name is kebab-case (plugin/marketplace identifier convention)', () => {
  assert.match(meta.name, /^[a-z0-9]+(-[a-z0-9]+)*$/);
});

test('version is a plain semantic version (no leading v, no marketplace-side duplication intent)', () => {
  assert.match(meta.version, /^\d+\.\d+\.\d+$/);
});
