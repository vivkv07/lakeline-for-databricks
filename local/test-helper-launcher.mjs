// SIMULATED: runs `node local/server.mjs` and start-helper.sh as child processes on ephemeral
// ports, with a fake browser opener (records the URL) and a fake Databricks CLI.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import nodeHttp from 'node:http';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { fakeCliDir, rawRequest } from './test-helper-fakes.mjs';
import { VERSION } from './server.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');
const SERVER = path.join(HERE, 'server.mjs');
const SCRIPT = path.join(ROOT, 'start-helper.sh');
const hasTools = spawnSync('bash', ['-c', 'command -v curl'], { encoding: 'utf8' }).status === 0;

function tmp() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'dcc-launch-'));
}

/** Fake browser opener: appends the URL it was given to urls.txt in its directory. */
function fakeOpener(dir) {
  const file = path.join(dir, 'opener.mjs');
  fs.writeFileSync(file, "import fs from 'node:fs';\nimport path from 'node:path';\nimport { fileURLToPath } from 'node:url';\nfs.appendFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), 'urls.txt'), process.argv[2] + '\\n');\n");
  return { file, urls: () => (fs.existsSync(path.join(dir, 'urls.txt')) ? fs.readFileSync(path.join(dir, 'urls.txt'), 'utf8').trim().split('\n').filter(Boolean) : []) };
}

async function waitFor(fn, ms = 8000) {
  const t0 = Date.now();
  for (;;) {
    const v = fn();
    if (v) return v;
    if (Date.now() - t0 > ms) throw new Error('timed out waiting');
    await new Promise((r) => setTimeout(r, 50));
  }
}

function runScript(env) {
  return new Promise((resolve) => {
    const child = spawn('bash', [SCRIPT], { env: Object.assign({}, process.env, env), stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    let err = '';
    child.stdout.on('data', (d) => (out += d));
    child.stderr.on('data', (d) => (err += d));
    child.on('close', (code) => resolve({ code, out, err }));
  });
}

async function fakeHealthServer(handler) {
  const server = nodeHttp.createServer(handler);
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  return { port: server.address().port, close: () => new Promise((r) => { server.close(() => r()); server.closeAllConnections(); }) };
}

test('--version prints the helper version only', () => {
  const r = spawnSync(process.execPath, [SERVER, '--version'], { encoding: 'utf8' });
  assert.equal(r.status, 0);
  assert.equal(r.stdout.trim(), VERSION);
  const bad = spawnSync(process.execPath, [SERVER, '--bogus'], { encoding: 'utf8' });
  assert.equal(bad.status, 2);
});

test('helper process: --open hands the key only to the browser opener; same-version start script reuses it', { skip: !hasTools && 'bash/curl not available' }, async () => {
  const dir = tmp();
  const opener = fakeOpener(dir);
  const fake = fakeCliDir();
  const env = Object.assign({}, process.env, { DCC_BROWSER_OPENER: opener.file, DCC_DATABRICKS_CLI: fake.cli });
  const child = spawn(process.execPath, [SERVER, '--open', '--port', '0'], { env, stdio: ['ignore', 'pipe', 'pipe'] });
  let out = '';
  child.stdout.on('data', (d) => (out += d));
  child.stderr.on('data', (d) => (out += d));
  try {
    const port = Number(await waitFor(() => (/listening on http:\/\/127\.0\.0\.1:(\d+)/.exec(out) || [])[1]));
    const url = await waitFor(() => opener.urls()[0]);
    const m = /^http:\/\/127\.0\.0\.1:(\d+)\/setup#k=([0-9a-f]{24})$/.exec(url);
    assert.ok(m, 'setup URL carries the key only in the fragment');
    assert.equal(Number(m[1]), port);
    const key = m[2];
    await waitFor(() => /Opened the setup page/.test(out));
    assert.ok(!out.includes(key), 'key not printed');

    const health = await rawRequest({ port, path: '/health', headers: { Host: '127.0.0.1:' + port } });
    assert.equal(health.json.version, VERSION);
    assert.ok(!health.text.includes(key));
    const setup = await rawRequest({ port, path: '/setup', headers: { Host: '127.0.0.1:' + port } });
    assert.ok(!setup.text.includes(key));

    // Same version answering /health → the start script reopens setup through the launcher and exits 0.
    const s = await runScript({ DCC_HELPER_PORT: String(port) });
    assert.equal(s.code, 0, s.err);
    assert.match(s.out, /already running/);
    assert.ok(!(s.out + s.err).includes(key));
    await waitFor(() => opener.urls().length === 2);
    assert.equal(opener.urls()[1], url, 'same key re-opened');

    // A second helper on the same port fails with guidance instead of a stack trace.
    const second = spawnSync(process.execPath, [SERVER, '--port', String(port)], { env, encoding: 'utf8' });
    assert.equal(second.status, 1);
    assert.match(second.stderr, /already in use/);
    assert.ok(!(second.stdout + second.stderr).includes(key));
  } finally {
    child.kill('SIGTERM');
    await new Promise((r) => child.once('exit', r));
  }
  assert.ok(!out.includes(opener.urls()[0].split('#k=')[1]), 'key never in helper output');
});

test('start script: an older helper gets a restart handoff; a foreign server is reported', { skip: !hasTools && 'bash/curl not available' }, async () => {
  const older = await fakeHealthServer((req, res) => {
    if (req.url === '/health') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ name: 'dcc-helper', version: '0.0.1', protocol: 1 }));
    }
    res.writeHead(500);
    res.end('launcher must not be called');
  });
  try {
    const r = await runScript({ DCC_HELPER_PORT: String(older.port) });
    assert.equal(r.code, 2);
    assert.match(r.err, /older helper \(0\.0\.1\)/);
    assert.match(r.err, /Ctrl\+C/);
    assert.match(r.err, /run this script again/);
  } finally {
    await older.close();
  }
  const foreign = await fakeHealthServer((req, res) => {
    res.writeHead(200, { 'Content-Type': 'text/html' });
    res.end('<html>something else</html>');
  });
  try {
    const r = await runScript({ DCC_HELPER_PORT: String(foreign.port) });
    assert.equal(r.code, 3);
    assert.match(r.err, /in use by another program/);
  } finally {
    await foreign.close();
  }
});

test('opener plan: Edge when installed, argument arrays only, URL shape enforced on Windows', async () => {
  const { openerPlan } = await import('./server.mjs');
  const url = 'http://127.0.0.1:8766/setup#k=' + '0123456789abcdef01234567';
  const mac = openerPlan(url, { platform: 'darwin', env: { HOME: '/nonexistent-home', DCC_SETUP_BROWSER: 'default' } });
  assert.deepEqual(mac, { cmd: 'open', args: [url], label: 'your default browser' });
  const win = openerPlan(url, { platform: 'win32', env: {} });
  assert.equal(win.cmd, 'cmd');
  assert.deepEqual(win.args, ['/c', 'start', '""', 'msedge', url]);
  assert.deepEqual(win.fallback.args, ['/c', 'start', '""', url]);
  assert.throws(() => openerPlan('http://127.0.0.1:8766/setup#k=x&calc', { platform: 'win32', env: {} }));
  const linux = openerPlan(url, { platform: 'linux', env: { DCC_SETUP_BROWSER: 'default' } });
  assert.deepEqual(linux, { cmd: 'xdg-open', args: [url], label: 'your default browser' });
});
