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
  const referenced = [...meta.mcp.urlTemplate.matchAll(placeholderRe)].map((m) => m[1]);
  assert.ok(referenced.length > 0, 'urlTemplate should reference at least one user_config placeholder');
  for (const key of referenced) {
    assert.ok(declared.has(key), `mcp.urlTemplate references undeclared user_config key "${key}"`);
  }
});

test('mcp.urlTemplate matches the documented <base_url>/mcp/<client_name>/<user_id> shape', () => {
  assert.equal(
    meta.mcp.urlTemplate,
    '${user_config.base_url}/mcp/${user_config.client_name}/${user_config.user_id}'
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
