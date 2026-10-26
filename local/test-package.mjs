// Packaging guard tests: allowlist contents and secret/real-workspace scanning.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { collect, inspect, storeEntries } from '../scripts/package.mjs';
import { load } from './support/load.mjs';

const ids = load('core/ids.js');
const cspDirective = (csp, name) => (csp.split(';').map((d) => d.trim().split(/\s+/)).find((d) => d[0] === name) || []).slice(1);

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

test('store build: manifest at the root without a key, developer links off, nothing outside extension/', () => {
  const entries = storeEntries();
  const names = entries.map((e) => e.name);
  assert.ok(names.includes('manifest.json'));
  assert.ok(!names.some((n) => n.startsWith('extension/') || n.startsWith('local/') || n === 'EXTENSION_ID' || n.endsWith('.mjs')));
  const manifest = JSON.parse(entries.find((e) => e.name === 'manifest.json').data.toString('utf8'));
  assert.equal('key' in manifest, false);
  assert.equal(manifest.optional_host_permissions.some((h) => h.includes('127.0.0.1')), false, 'no local test-workspace permission in the store build');
  assert.equal(manifest.name, 'Lakeline for Databricks');
  const flags = entries.find((e) => e.name === 'src/core/flags.js').data.toString('utf8');
  assert.match(flags, /devTools:\s*false/);
  assert.ok(names.includes('fonts/OFL-Inter.txt') && names.includes('icons/icon-128.png'));
  assert.deepEqual(inspect(entries.map((e) => ({ name: e.name, text: e.data.toString('latin1') }))), []);
});

test('extension CSP: pages and the service worker connect only to workspace hosts and the local helper', () => {
  const manifest = JSON.parse(readFileSync(new URL('../extension/manifest.json', import.meta.url), 'utf8'));
  const csp = manifest.content_security_policy.extension_pages;
  assert.deepEqual(cspDirective(csp, 'script-src'), ["'self'"]);
  // The same workspace families classifyOrigin accepts, the helper and the dev-only test workspace.
  const workspaces = ids.HOST_SUFFIXES.map((h) => 'https://*' + h.suffix);
  assert.deepEqual(cspDirective(csp, 'connect-src').sort(), ["'self'", ...workspaces, 'http://127.0.0.1:8766', ids.FIXTURE_ORIGIN].sort());

  const store = JSON.parse(storeEntries().find((e) => e.name === 'manifest.json').data.toString('utf8'));
  const storeCsp = store.content_security_policy.extension_pages;
  assert.deepEqual(cspDirective(storeCsp, 'connect-src').sort(), ["'self'", ...workspaces, 'http://127.0.0.1:8766'].sort(), 'no test workspace in the store build');
  assert.equal(storeCsp.replace(' ' + ids.FIXTURE_ORIGIN, ''), storeCsp, 'store CSP never mentions the test workspace');
  assert.deepEqual(cspDirective(storeCsp, 'script-src'), ["'self'"]);
});

test('ZIP archives are valid: the central directory agrees with every local header and each entry inflates to its CRC', async () => {
  const { zip } = await import('../scripts/package.mjs');
  const { inflateRawSync } = await import('node:zlib');
  const entries = [{ name: 'a.txt', data: Buffer.from('hello lakeline '.repeat(50)) }, { name: 'start-helper.sh', data: Buffer.from('#!/bin/sh\necho ok\n') }];
  const buf = zip(entries);
  const eocd = buf.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]));
  assert.ok(eocd > 0, 'end of central directory record');
  const count = buf.readUInt16LE(eocd + 10);
  let p = buf.readUInt32LE(eocd + 16);
  assert.equal(count, entries.length);
  const crc32 = (b) => {
    let c = 0xffffffff;
    for (const x of b) {
      c ^= x;
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    }
    return (c ^ 0xffffffff) >>> 0;
  };
  for (let i = 0; i < count; i++) {
    assert.equal(buf.readUInt32LE(p), 0x02014b50, 'central header signature');
    const method = buf.readUInt16LE(p + 10);
    const crc = buf.readUInt32LE(p + 16);
    const csize = buf.readUInt32LE(p + 20);
    const usize = buf.readUInt32LE(p + 24);
    const nlen = buf.readUInt16LE(p + 28);
    const local = buf.readUInt32LE(p + 42);
    const name = buf.subarray(p + 46, p + 46 + nlen).toString('utf8');
    assert.equal(method, 8, name + ': central directory says deflate');
    assert.equal(buf.readUInt16LE(p + 6), 20, name + ': version needed');
    assert.equal(buf.readUInt16LE(local + 8), method, name + ': local header agrees on the method');
    const start = local + 30 + buf.readUInt16LE(local + 26) + buf.readUInt16LE(local + 28);
    const data = inflateRawSync(buf.subarray(start, start + csize));
    assert.equal(data.length, usize, name + ': size');
    assert.equal(crc32(data), crc, name + ': CRC-32');
    p += 46 + nlen + buf.readUInt16LE(p + 30) + buf.readUInt16LE(p + 32);
  }
});
