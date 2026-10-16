// Packaging guard tests: allowlist contents and secret/real-workspace scanning.
import test from 'node:test';
import assert from 'node:assert/strict';
import { collect, inspect, storeEntries } from '../scripts/package.mjs';

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

test('store build: manifest at the root without a key, experimental browser login off, nothing outside extension/', () => {
  const entries = storeEntries();
  const names = entries.map((e) => e.name);
  assert.ok(names.includes('manifest.json'));
  assert.ok(!names.some((n) => n.startsWith('extension/') || n.startsWith('local/') || n === 'EXTENSION_ID' || n.endsWith('.mjs')));
  const manifest = JSON.parse(entries.find((e) => e.name === 'manifest.json').data.toString('utf8'));
  assert.equal('key' in manifest, false);
  assert.equal(manifest.optional_host_permissions.some((h) => h.includes('127.0.0.1')), false, 'no local test-workspace permission in the store build');
  assert.equal(manifest.name, 'Lakeline for Databricks');
  const flags = entries.find((e) => e.name === 'src/core/flags.js').data.toString('utf8');
  assert.match(flags, /sessionLogin:\s*false/);
  assert.ok(names.includes('fonts/OFL-Inter.txt') && names.includes('icons/icon-128.png'));
  assert.deepEqual(inspect(entries.map((e) => ({ name: e.name, text: e.data.toString('latin1') }))), []);
});
