import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const manifest = JSON.parse(readFileSync(new URL('../extension/manifest.json', import.meta.url), 'utf8'));
const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));

// Chrome Web Store upload limits: rejected at upload time if exceeded.
test('manifest text fits the Chrome Web Store limits', () => {
  assert.ok(manifest.name.length <= 75, `name is ${manifest.name.length} chars (max 75)`);
  assert.ok(manifest.short_name.length <= 12, `short_name is ${manifest.short_name.length} chars (max 12)`);
  assert.ok(manifest.description.length <= 132, `description is ${manifest.description.length} chars (max 132)`);
});

test('manifest and package.json versions match', () => {
  assert.equal(manifest.version, pkg.version);
});
