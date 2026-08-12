// Guards the plugin-id/description rename (memforge-memory -> cortadel-memory, "MemForge" ->
// "Cortadel" in the description) so a partially-reverted rebrand fails CI instead of shipping
// silently — the manifest has no other test coverage.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const MANIFEST = fileURLToPath(new URL('../.claude-plugin/plugin.json', import.meta.url));

test('plugin.json is named cortadel-memory and its description says Cortadel, not MemForge', () => {
  const manifest = JSON.parse(readFileSync(MANIFEST, 'utf8'));
  assert.equal(manifest.name, 'cortadel-memory');
  assert.match(manifest.description, /Cortadel/);
  assert.doesNotMatch(manifest.description, /MemForge/i);
});
