// Remembered tokens live in the extension's own IndexedDB, never in chrome.storage.local (which
// content scripts can read and write). Storage areas are FAKES here; the real IndexedDB path runs
// in local/browser/test-e2e.mjs. This is a simulated test.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import { load, fakeArea } from './support/load.mjs';

const secretsMod = load('background/secrets.js');
const KEY = secretsMod.REMEMBERED_PAT_KEY;
const A = 'https://dbc-aaa.cloud.databricks.com';
const B = 'https://dbc-bbb.cloud.databricks.com';
const PAT_A = 'dapi' + 'a1'.repeat(16);
const PAT_B = 'dapi' + 'b2'.repeat(16);
const PAT_NEW = 'dapi' + 'c3'.repeat(16);

function env(legacyInitial = {}) {
  const session = fakeArea();
  const idb = fakeArea(); // stands in for idb-area.js
  const legacy = fakeArea(legacyInitial); // chrome.storage.local
  const writes = [];
  const realSet = legacy.set.bind(legacy);
  legacy.set = async (obj) => {
    writes.push(Object.keys(obj));
    return realSet(obj);
  };
  return { session, idb, legacy, writes, secrets: secretsMod.create(session, idb, { legacyArea: legacy }) };
}

const secretKeys = (area) => Object.keys(area.data).filter((k) => k.startsWith('dcc.secrets'));
/** The remembered map as stored: encrypted, so no token text appears anywhere in it. */
const storedPlain = (area) => JSON.stringify(area.data[KEY], (k, v) => (v instanceof Uint8Array ? Array.from(v) : v));
const rememberedIn = async (idb) => {
  const restarted = secretsMod.create(fakeArea(), idb);
  const out = {};
  for (const o of [A, B]) if (await restarted.isPatRemembered(o)) out[o] = await restarted.getPat(o);
  return out;
};

test('a remembered token goes to the extension-only area and never to chrome.storage.local', async () => {
  const e = env();
  await e.secrets.setPat(A, PAT_A, { remember: true });
  assert.equal(e.idb.data[KEY].v, 1, 'stored encrypted (AES-GCM)');
  assert.ok(!storedPlain(e.idb).includes(PAT_A), 'no token text at rest');
  assert.equal(e.idb.data['dcc.secrets.encKey'].extractable, false, 'the key cannot be exported');
  assert.deepEqual(await rememberedIn(e.idb), { [A]: PAT_A });
  assert.deepEqual(secretKeys(e.legacy), [], 'nothing under dcc.secrets in storage.local');
  assert.deepEqual(e.writes, [], 'storage.local is never written');
  assert.equal(await e.secrets.isPatRemembered(A), true);

  // After a browser restart (empty session area) the token comes back from the extension-only area.
  const restarted = secretsMod.create(fakeArea(), e.idb, { legacyArea: e.legacy });
  assert.equal(await restarted.getPat(A), PAT_A);

  await restarted.clearPat(A);
  assert.deepEqual(await rememberedIn(e.idb), {});
  assert.equal(await restarted.getPat(A), null);
});

test('tokens remembered by 0.1.1 in chrome.storage.local move over once, and the old key is deleted', async () => {
  const e = env({ [KEY]: { [A]: PAT_A, [B]: PAT_B, 'https://dbc-ccc.cloud.databricks.com': 'not-a-token' } });
  assert.equal(await e.secrets.getPat(A), PAT_A);
  assert.deepEqual(await rememberedIn(e.idb), { [A]: PAT_A, [B]: PAT_B }, 'implausible values are dropped');
  assert.ok(!storedPlain(e.idb).includes(PAT_A) && !storedPlain(e.idb).includes(PAT_B), 'moved tokens are encrypted too');
  assert.equal(KEY in e.legacy.data, false, 'old key removed from storage.local');
  assert.equal(await e.secrets.isPatRemembered(B), true);
  assert.deepEqual(e.writes, [], 'migration only deletes from storage.local');
});

test('migration keeps a newer remembered token, runs once, and retries after a failure', async () => {
  const e = env({ [KEY]: { [A]: PAT_A } });
  await e.idb.set({ [KEY]: { [A]: PAT_NEW } });
  let reads = 0;
  const realGet = e.legacy.get.bind(e.legacy);
  e.legacy.get = async (k) => {
    reads += 1;
    if (reads === 1) throw new Error('storage busy');
    return realGet(k);
  };
  await assert.rejects(e.secrets.getPat(A), /storage busy/);
  assert.equal(await e.secrets.getPat(A), PAT_NEW, 'the extension-only copy wins');
  await e.secrets.getPat(B);
  await e.secrets.migrate();
  assert.equal(reads, 2, 'one failed attempt, one successful one, then never again');
  assert.equal(KEY in e.legacy.data, false);
});

test('the service worker keeps remembered tokens in IndexedDB and passes storage.local only for migration', () => {
  const sw = readFileSync(new URL('../extension/src/background/service-worker.js', import.meta.url), 'utf8');
  assert.match(sw, /DCC\.secrets\.create\(chrome\.storage\.session, DCC\.idbArea\.create\(\), \{ legacyArea: chrome\.storage\.local \}\)/);
  assert.match(sw, /'\.\/idb-area\.js',\s*'\.\/secrets\.js'/, 'idb-area.js loads before secrets.js');
  // No other extension file touches the remembered-token key.
  const root = new URL('../extension/', import.meta.url).pathname;
  const hits = [];
  (function walk(dir) {
    for (const name of readdirSync(dir)) {
      const p = path.join(dir, name);
      if (statSync(p).isDirectory()) walk(p);
      else if (p.endsWith('.js') && readFileSync(p, 'utf8').includes('dcc.secrets.patRemembered')) hits.push(path.relative(root, p));
    }
  })(root);
  assert.deepEqual(hits, ['src/background/secrets.js']);
});

test('tampered or unreadable remembered data counts as empty instead of failing', async () => {
  const e = env();
  await e.secrets.setPat(A, PAT_A, { remember: true });
  const box = e.idb.data[KEY];
  box.data[0] ^= 0xff; // flip bits: AES-GCM authentication fails
  const restarted = secretsMod.create(fakeArea(), e.idb);
  assert.equal(await restarted.getPat(A), null);
  assert.equal(await restarted.isPatRemembered(A), false);
  await restarted.setPat(B, PAT_B, { remember: true });
  assert.equal(await secretsMod.create(fakeArea(), e.idb).getPat(B), PAT_B, 'remembering again works');
});
