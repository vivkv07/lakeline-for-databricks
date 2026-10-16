// Packaging guard tests: allowlist contents and secret/real-workspace scanning.
import test from 'node:test';
import assert from 'node:assert/strict';
import { collect, inspect } from '../scripts/package.mjs';

test('allowlist never includes tests, notes, node_modules or private files', () => {
  const files = collect();
  assert.ok(files.includes('extension/manifest.json'));
  for (const f of files) {
    assert.doesNotMatch(f, /^(notes|node_modules|dist|\.git)\//, f);
    assert.doesNotMatch(f, /(^|\/)test-[^/]*\.mjs$/, f);
    if (f.includes('/support/')) assert.equal(f, 'local/support/sqlengine.mjs', 'only the fixture SQL engine ships from support/');
    assert.doesNotMatch(f, /costs\.json$|\.pem$|\.databrickscfg/, f);
  }
});

test('inspection rejects forbidden paths, tokens, keys and real workspace hosts', () => {
  const bad = [
    { name: 'extension/src/x.js', text: 'const t = "' + 'dapi' + '0123456789abcdef'.repeat(2) + '";' },
    { name: 'local/a.js', text: '{"access_token":"abcdefghijkl"}' },
    { name: 'local/b.js', text: '-----BEGIN RSA PRIVATE KEY-----' },
    { name: 'README.md', text: 'see https://adb-1234567890123456.7.azuredatabricks.net/' },
    { name: 'costs.json', text: '{}' },
    { name: 'x/.databrickscfg', text: '' },
  ];
  for (const f of bad) assert.equal(inspect([f]).length > 0, true, f.name);
  assert.deepEqual(inspect([{ name: 'README.md', text: 'Synthetic workspace https://dbc-example.cloud.databricks.com' }]), []);
});
