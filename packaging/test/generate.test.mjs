// Output-level checks over what packaging/generate.mjs produces from packaging/plugin.metadata.json.
// Generation happens into an ephemeral temp directory (via generate()'s `root` param) so these
// tests never depend on — or risk hand-editing — the real generated files checked into the repo;
// the "did the repo forget to regenerate" question is a separate concern, covered by CI's
// `git status --porcelain` diff-check after running the same generator for real.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync, existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  generate,
  loadMetadata,
  outputPaths,
  buildMarketplaceJson,
  buildClaudePluginJson,
  buildCodexPluginJson,
  METADATA_PATH,
} from '../generate.mjs';

const REPO_ROOT = fileURLToPath(new URL('../../', import.meta.url));
const meta = loadMetadata(METADATA_PATH);

function generateToTemp() {
  const dir = mkdtempSync(path.join(tmpdir(), 'cortadel-packaging-'));
  generate({ root: dir, metadataPath: METADATA_PATH });
  return dir;
}

function readJson(p) {
  return JSON.parse(readFileSync(p, 'utf8'));
}

// ---------- basic shape: 4 files, all valid JSON ----------

test('generate() writes all four files as valid, pretty-printed JSON', () => {
  const dir = generateToTemp();
  try {
    const paths = outputPaths(dir);
    for (const [label, p] of Object.entries(paths)) {
      assert.ok(existsSync(p), `${label} was not written at ${p}`);
      const raw = readFileSync(p, 'utf8');
      assert.doesNotThrow(() => JSON.parse(raw), `${label} is not valid JSON`);
      assert.ok(raw.endsWith('\n'), `${label} should end with a trailing newline`);
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ---------- version: exactly one generated file per host, zero in marketplace entries ----------

test('version appears in the Claude Code plugin.json and nowhere else on the Claude side', () => {
  const dir = generateToTemp();
  try {
    const paths = outputPaths(dir);
    const claudePlugin = readJson(paths.claudePlugin);
    const claudeMarketplace = readJson(paths.claudeMarketplace);
    assert.equal(claudePlugin.version, meta.version);
    assert.ok(!('version' in claudeMarketplace), 'marketplace manifest itself must not carry version');
    for (const entry of claudeMarketplace.plugins) {
      assert.ok(!('version' in entry), `marketplace entry "${entry.name}" must not carry version`);
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('version appears in the Codex plugin.json and nowhere else on the Codex side', () => {
  const dir = generateToTemp();
  try {
    const paths = outputPaths(dir);
    const codexPlugin = readJson(paths.codexPlugin);
    const codexMarketplace = readJson(paths.codexMarketplace);
    assert.equal(codexPlugin.version, meta.version);
    assert.ok(!('version' in codexMarketplace), 'marketplace manifest itself must not carry version');
    for (const entry of codexMarketplace.plugins) {
      assert.ok(!('version' in entry), `marketplace entry "${entry.name}" must not carry version`);
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('exactly one of the two per-host generated files carries version, for each host', () => {
  const dir = generateToTemp();
  try {
    const paths = outputPaths(dir);
    const hosts = [
      { name: 'claude', pluginPath: paths.claudePlugin, marketplacePath: paths.claudeMarketplace },
      { name: 'codex', pluginPath: paths.codexPlugin, marketplacePath: paths.codexMarketplace },
    ];
    for (const host of hosts) {
      const filesWithVersion = [host.pluginPath, host.marketplacePath].filter(
        (p) => 'version' in readJson(p)
      );
      assert.equal(
        filesWithVersion.length,
        1,
        `host "${host.name}" must have exactly one generated file carrying version, got ${filesWithVersion.length}`
      );
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ---------- marketplace source paths resolve to a real plugin, in the real repo ----------

test('every marketplace source path exists on disk and contains a plugin manifest', () => {
  const marketplace = buildMarketplaceJson(meta);
  assert.ok(marketplace.plugins.length > 0);
  for (const entry of marketplace.plugins) {
    assert.match(entry.source, /^\.\//, `source "${entry.source}" must be a "./"-relative path`);
    assert.doesNotMatch(entry.source, /\.\./, `source "${entry.source}" must not escape the marketplace root`);
    const resolved = path.join(REPO_ROOT, entry.source);
    assert.ok(existsSync(resolved), `source path does not exist: ${resolved}`);
    const hasClaudeManifest = existsSync(path.join(resolved, '.claude-plugin', 'plugin.json'));
    const hasCodexManifest = existsSync(path.join(resolved, '.codex-plugin', 'plugin.json'));
    assert.ok(
      hasClaudeManifest || hasCodexManifest,
      `${resolved} does not contain a .claude-plugin/plugin.json or .codex-plugin/plugin.json`
    );
  }
});

// ---------- marketplace entry name === plugin.json name ----------

test('marketplace entry name matches the Claude Code plugin.json name', () => {
  const marketplace = buildMarketplaceJson(meta);
  const claudePlugin = buildClaudePluginJson(meta);
  assert.equal(marketplace.plugins[0].name, claudePlugin.name);
});

test('marketplace entry name matches the Codex plugin.json name', () => {
  const marketplace = buildMarketplaceJson(meta);
  const codexPlugin = buildCodexPluginJson(meta);
  assert.equal(marketplace.plugins[0].name, codexPlugin.name);
});

// ---------- Codex plugin.json is skills-only ----------

test('Codex plugin.json carries no mcpServers, hooks, or userConfig (skills-only by design)', () => {
  const codexPlugin = buildCodexPluginJson(meta);
  assert.ok(!('mcpServers' in codexPlugin), 'Codex format cannot template a self-hosted URL — must not ship mcpServers');
  assert.ok(!('hooks' in codexPlugin));
  assert.ok(!('userConfig' in codexPlugin));
  assert.equal(codexPlugin.skills, './skills/');
});

test('Claude Code plugin.json carries inline mcpServers with type "http" and the full userConfig', () => {
  const claudePlugin = buildClaudePluginJson(meta);
  assert.equal(claudePlugin.mcpServers.cortadel.type, 'http');
  assert.equal(claudePlugin.mcpServers.cortadel.url, meta.mcp.urlTemplate);
  assert.equal(claudePlugin.mcpServers.cortadel.headers.Authorization, 'Bearer ${user_config.api_key}');
  assert.deepEqual(claudePlugin.userConfig, meta.userConfig);
});

// ---------- loadMetadata() guard rails ----------

function withTempMetadata(overrides, fn) {
  const dir = mkdtempSync(path.join(tmpdir(), 'cortadel-metadata-'));
  const p = path.join(dir, 'plugin.metadata.json');
  const base = JSON.parse(readFileSync(METADATA_PATH, 'utf8'));
  const merged = { ...base, ...overrides };
  writeFileSync(p, JSON.stringify(merged, null, 2));
  try {
    fn(p);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test('loadMetadata() rejects a userConfig key that is not a valid identifier', () => {
  withTempMetadata(
    { userConfig: { ...meta.userConfig, 'bad-key': { type: 'string', title: 't', description: 'd' } } },
    (p) => assert.throws(() => loadMetadata(p), /bad-key/)
  );
});

test('loadMetadata() rejects a userConfig option missing a required key', () => {
  withTempMetadata(
    { userConfig: { ...meta.userConfig, base_url: { type: 'string', title: 'Only title and type' } } },
    (p) => assert.throws(() => loadMetadata(p), /description/)
  );
});

test('loadMetadata() rejects a userConfig option with a disallowed key', () => {
  withTempMetadata(
    {
      userConfig: {
        ...meta.userConfig,
        base_url: { ...meta.userConfig.base_url, unexpected_field: true },
      },
    },
    (p) => assert.throws(() => loadMetadata(p), /unexpected_field/)
  );
});

test('loadMetadata() rejects an mcp.urlTemplate referencing an undeclared user_config key', () => {
  withTempMetadata(
    { mcp: { ...meta.mcp, urlTemplate: '${user_config.base_url}/mcp/${user_config.not_declared}' } },
    (p) => assert.throws(() => loadMetadata(p), /not_declared/)
  );
});

test('loadMetadata() accepts the real packaging/plugin.metadata.json unchanged', () => {
  assert.doesNotThrow(() => loadMetadata(METADATA_PATH));
});
