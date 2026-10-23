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

// The shortcut and right-click menu fall back to chrome.action.openPopup(), which
// before Chrome 127 was limited to policy-installed extensions and rejected otherwise.
test('minimum_chrome_version covers chrome.action.openPopup()', () => {
  const min = Number(manifest.minimum_chrome_version);
  assert.ok(min >= 127, `minimum_chrome_version is ${manifest.minimum_chrome_version}; chrome.action.openPopup() needs Chrome 127+`);
});
