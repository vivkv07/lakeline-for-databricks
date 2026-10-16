#!/usr/bin/env node
/*
 * Build the sanitized distributable ZIP from an EXPLICIT allowlist, then inspect it.
 * Usage: node scripts/package.mjs [--out dist/databricks-cost-companion-<version>.zip]
 *
 * Included: extension assets, helper source, launcher scripts, docs, example data, synthetic
 * fixture pages. Excluded by construction (never listed) and re-checked after build: auth/CLI
 * directories, real cost files, tokens/keys, browser profiles, diagnostics, screenshots, tests'
 * scratch output, node_modules, notes/.
 */
import { readFileSync, readdirSync, statSync, mkdirSync, writeFileSync, existsSync } from 'node:fs';
import { deflateRawSync } from 'node:zlib';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const version = JSON.parse(readFileSync(path.join(ROOT, 'extension/manifest.json'), 'utf8')).version;

/** Allowlist: [path relative to repo root, {recursive, extensions}] */
const ALLOW = [
  ['extension/manifest.json'],
  ['extension/EXTENSION_ID'],
  ['extension/icons', { recursive: true, ext: ['.png'] }],
  ['extension/fonts', { recursive: false, ext: ['.woff2', '.txt'] }],
  ['extension/src', { recursive: true, ext: ['.js'] }],
  ['extension/ui', { recursive: true, ext: ['.html', '.js', '.css'] }],
  ['extension/docs', { recursive: true, ext: ['.html', '.css'] }],
  ['local/server.mjs'],
  ['local/oauth-bridge.mjs'],
  ['local/setup.html'],
  ['local/setup.js'],
  ['local/setup.css'],
  ['local/workspace.html'],
  ['local/workspace.js'],
  ['local/workspace.css'],
  ['local/fixture', { recursive: false, ext: ['.html', '.svg'] }],
  ['local/fixture-server.mjs'],
  ['local/fixture-data.mjs'],
  ['local/support/sqlengine.mjs'],
  ['package-lock.json'],
  ['start-helper.command'],
  ['start-helper.sh'],
  ['costs.example.json'],
  ['README.md'],
  ['CHANGELOG.md'],
  ['package.json'],
];

/** Anything matching these must never be in the archive, even if an allowlisted dir contains it. */
const FORBIDDEN_PATH = [/(^|\/)\.databricks(cfg)?(\/|$)/, /(^|\/)node_modules\//, /(^|\/)\.git\//, /(^|\/)costs\.json$/, /\.(pem|key|p12|pfx|crx|env)$/i, /(^|\/)diagnostics\//, /(^|\/)profiles?\//, /screenshot/i, /(^|\/)notes\//, /(^|\/)test-results\//, /\.DS_Store$/];
const SECRET_CONTENT = [
  /dapi[0-9a-f]{32}/i,
  /eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/,
  /"(access_token|refresh_token)"\s*:\s*"[^"]{8,}"/,
  /-----BEGIN [A-Z ]*PRIVATE KEY-----/,
  /\b(adb-\d{10,}\.\d+\.azuredatabricks\.net|dbc-[0-9a-f-]{8,}\.cloud\.databricks\.com)\b/i,
];

function collect() {
  const files = [];
  for (const [rel, opts = {}] of ALLOW) {
    const abs = path.join(ROOT, rel);
    if (!existsSync(abs)) continue;
    const st = statSync(abs);
    if (st.isFile()) {
      files.push(rel);
      continue;
    }
    const walk = (dir) => {
      for (const name of readdirSync(path.join(ROOT, dir)).sort()) {
        const r = path.posix.join(dir, name);
        const s = statSync(path.join(ROOT, r));
        if (s.isDirectory()) {
          if (opts.recursive) walk(r);
        } else if (!opts.ext || opts.ext.includes(path.extname(name))) files.push(r);
      }
    };
    walk(rel);
  }
  return files;
}

function inspect(files) {
  const problems = [];
  for (const f of files) {
    const text = typeof f === 'object' ? f.text : readFileSync(path.join(ROOT, f)).toString('latin1');
    const name = typeof f === 'object' ? f.name : f;
    if (FORBIDDEN_PATH.some((re) => re.test(name))) problems.push('forbidden path: ' + name);
    for (const re of SECRET_CONTENT) {
      const m = re.exec(text);
      // Docs and tests may describe token *formats*; only flag concrete-looking values.
      if (m) problems.push('secret-like or real-workspace content in ' + name + ': ' + m[0].slice(0, 12) + '…');
    }
  }
  return problems;
}

/* Minimal ZIP writer (deflate, no external deps). */
function crc32(buf) {
  let c;
  let crc = 0xffffffff;
  for (let n = 0; n < buf.length; n++) {
    c = (crc ^ buf[n]) & 0xff;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    crc = (crc >>> 8) ^ c;
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function zip(entries) {
  const local = [];
  const central = [];
  let offset = 0;
  const dosTime = 0;
  const dosDate = ((2026 - 1980) << 9) | (10 << 5) | 15; // fixed date → reproducible archive
  for (const { name, data } of entries) {
    const nameBuf = Buffer.from(name, 'utf8');
    const comp = deflateRawSync(data, { level: 9 });
    const crc = crc32(data);
    const lh = Buffer.alloc(30);
    lh.writeUInt32LE(0x04034b50, 0); lh.writeUInt16LE(20, 4); lh.writeUInt16LE(0x0800, 6); lh.writeUInt16LE(8, 8);
    lh.writeUInt16LE(dosTime, 10); lh.writeUInt16LE(dosDate, 12); lh.writeUInt32LE(crc, 14);
    lh.writeUInt32LE(comp.length, 18); lh.writeUInt32LE(data.length, 22); lh.writeUInt16LE(nameBuf.length, 26); lh.writeUInt16LE(0, 28);
    local.push(lh, nameBuf, comp);
    const ch = Buffer.alloc(46);
    ch.writeUInt32LE(0x02014b50, 0); ch.writeUInt16LE((3 << 8) | 20, 4); // made by Unix → modes honored ch.writeUInt16LE(20, 6); ch.writeUInt16LE(0x0800, 8); ch.writeUInt16LE(8, 10);
    ch.writeUInt16LE(dosTime, 12); ch.writeUInt16LE(dosDate, 14); ch.writeUInt32LE(crc, 16); ch.writeUInt32LE(comp.length, 20);
    ch.writeUInt32LE(data.length, 24); ch.writeUInt16LE(nameBuf.length, 28); ch.writeUInt32LE(0, 30); ch.writeUInt32LE(0, 34);
    ch.writeUInt32LE(name.endsWith('.command') || name.endsWith('.sh') ? (0o100755 << 16) >>> 0 : (0o100644 << 16) >>> 0, 38);
    ch.writeUInt32LE(offset, 42);
    central.push(ch, nameBuf);
    offset += lh.length + nameBuf.length + comp.length;
  }
  const cd = Buffer.concat(central);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(entries.length, 8); end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(cd.length, 12); end.writeUInt32LE(offset, 16);
  return Buffer.concat([...local, cd, end]);
}

function main() {
  const args = process.argv.slice(2);
  const outArg = args.indexOf('--out');
  const out = path.resolve(ROOT, outArg !== -1 ? args[outArg + 1] : `dist/databricks-cost-companion-${version}.zip`);
  const files = collect();
  const problems = inspect(files);
  if (problems.length) {
    console.error('Refusing to package:\n  ' + problems.join('\n  '));
    process.exit(1);
  }
  const prefix = 'databricks-cost-companion/';
  const archive = zip(files.map((f) => ({ name: prefix + f, data: readFileSync(path.join(ROOT, f)) })));
  mkdirSync(path.dirname(out), { recursive: true });
  writeFileSync(out, archive);
  console.log(`Wrote ${path.relative(ROOT, out)} (${files.length} files, ${archive.length} bytes)`);
  if (args.includes('--list')) for (const f of files) console.log('  ' + f);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main();
export { collect, inspect, ALLOW, FORBIDDEN_PATH, SECRET_CONTENT };
