/*
 * Databricks CLI OAuth bridge for the local helper.
 *
 * The helper never handles OAuth itself: the Databricks CLI (v1.12+) runs the browser sign-in
 * and keeps the credentials in its own store (OS keychain on 1.x). This module only:
 *   - derives a dedicated CLI profile name from the explicitly selected workspace origin
 *     ('dcc-<host>-<hash>' for costs, 'dcc-mon-<host>-<hash>' for the monitor). It never uses
 *     DEFAULT or any other existing profile.
 *   - checks the CLI version,
 *   - reads a short-lived access token with `databricks auth token --profile <p>` (the JSON also
 *     carries a refresh token; only access_token and expiry are kept, in memory, and the access
 *     token is only ever sent to that workspace origin as a Bearer header),
 *   - runs `databricks auth login --host <origin> --profile <p> --scopes sql|all-apis` when no
 *     valid session exists.
 * Child processes are started with argument arrays (no shell) and never receive tokens on the
 * command line. Nothing is written to disk by the helper.
 */
import { spawn } from 'node:child_process';
import crypto from 'node:crypto';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const ids = require('../extension/src/core/ids.js');
const errors = require('../extension/src/errors.js');

export const MIN_CLI_VERSION = Object.freeze([1, 12, 0]);
export const SCOPES = Object.freeze({ cost: 'sql', monitor: 'all-apis' });
export const LOGIN_TIMEOUT_MS = 5 * 60 * 1000;
const VERSION_TIMEOUT_MS = 10000;
const TOKEN_TIMEOUT_MS = 60000;
const MAX_OUTPUT = 256 * 1024;
const TOKEN_SKEW_MS = 60000;
const CLI_INFO_TTL_MS = 15000;

/** Workspace origin only (never the fixture, account console or anything else). */
export function workspaceOrigin(origin) {
  const cls = ids.classifyOrigin(origin);
  if (!cls.ok || cls.kind !== 'workspace' || cls.origin !== origin) {
    throw new errors.DccError({ code: 'UNKNOWN', message: 'Choose a supported Databricks workspace URL first' });
  }
  return cls;
}

/**
 * Dedicated CLI profile for (origin, purpose). Deterministic, origin-specific (host slug plus a
 * hash of the full origin) and purpose-specific (prefix). Always starts with 'dcc-'.
 */
export function profileName(origin, purpose = 'cost') {
  const cls = workspaceOrigin(origin);
  if (purpose !== 'cost' && purpose !== 'monitor') throw new errors.DccError({ code: 'UNKNOWN', message: 'Unknown sign-in purpose' });
  const slug = cls.host.replace(/\./g, '-').replace(/[^a-z0-9-]/g, '').slice(0, 40).replace(/-+$/, '');
  const hash = crypto.createHash('sha256').update(cls.origin).digest('hex').slice(0, 8);
  return (purpose === 'monitor' ? 'dcc-mon-' : 'dcc-') + slug + '-' + hash;
}

/** "Databricks CLI v1.21.0" → {major, minor, patch, text:'1.21.0'} */
export function parseCliVersion(text) {
  const m = /\bv?(\d{1,4})\.(\d{1,4})\.(\d{1,4})\b/.exec(String(text || ''));
  if (!m) return null;
  return { major: Number(m[1]), minor: Number(m[2]), patch: Number(m[3]), text: m[1] + '.' + m[2] + '.' + m[3] };
}

export function isSupportedVersion(v) {
  if (!v) return false;
  const a = [v.major, v.minor, v.patch];
  for (let i = 0; i < 3; i++) {
    if (a[i] !== MIN_CLI_VERSION[i]) return a[i] > MIN_CLI_VERSION[i];
  }
  return true;
}

/**
 * Environment for the CLI child: drop variables that would override or conflict with the
 * dedicated profile (host, token, client credentials, another profile). The config-file location
 * is kept so a user's custom CLI config path still works.
 */
export function cliEnv(env) {
  const out = {};
  for (const [k, v] of Object.entries(env || {})) {
    if (/^DATABRICKS_/i.test(k) && k.toUpperCase() !== 'DATABRICKS_CONFIG_FILE') continue;
    if (/^ARM_(CLIENT_ID|CLIENT_SECRET|TENANT_ID|USE_MSI)$/i.test(k)) continue;
    out[k] = v;
  }
  return out;
}

/**
 * Run the CLI with an argument array. Resolves {code, stdout, stderr, timedOut}; rejects with
 * {notFound:true} when the binary is missing. Output is bounded and never logged here.
 */
function runCli(cliPath, args, { timeoutMs, env, onLine } = {}) {
  return new Promise((resolve, reject) => {
    const isScript = /\.(mjs|cjs|js)$/i.test(cliPath);
    const cmd = isScript ? process.execPath : cliPath;
    const argv = isScript ? [path.resolve(cliPath), ...args] : args;
    let child;
    try {
      child = spawn(cmd, argv, { stdio: ['ignore', 'pipe', 'pipe'], env, windowsHide: true, shell: false });
    } catch (e) {
      reject(Object.assign(new Error('spawn failed'), { notFound: e && e.code === 'ENOENT' }));
      return;
    }
    let stdout = '';
    let stderr = '';
    let timedOut = false;
    let settled = false;
    const take = (buf, which) => {
      const s = buf.toString('utf8');
      if (which === 'out' && stdout.length < MAX_OUTPUT) stdout += s;
      if (which === 'err' && stderr.length < MAX_OUTPUT) stderr += s;
      if (onLine) for (const line of s.split(/\r?\n/)) if (line.trim()) onLine(line);
    };
    child.stdout.on('data', (b) => take(b, 'out'));
    child.stderr.on('data', (b) => take(b, 'err'));
    const timer = timeoutMs
      ? setTimeout(() => {
          timedOut = true;
          child.kill('SIGTERM');
          setTimeout(() => child.kill('SIGKILL'), 2000).unref();
        }, timeoutMs)
      : null;
    child.on('error', (e) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      reject(Object.assign(new Error('CLI could not be started'), { notFound: e && (e.code === 'ENOENT' || e.code === 'EACCES') }));
    });
    child.on('close', (code) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      resolve({ code, stdout, stderr, timedOut });
    });
  });
}

/**
 * @param {object} o
 * @param {string} [o.cliPath]   binary path; default env DCC_DATABRICKS_CLI or 'databricks' on PATH
 * @param {object} [o.env]       base environment for the CLI (sanitized)
 * @param {Function} [o.now]
 * @param {number} [o.loginTimeoutMs]
 * @param {Function} [o.log]     receives already-redacted lines
 */
export function createOAuthBridge(o = {}) {
  const cliPath = o.cliPath || process.env.DCC_DATABRICKS_CLI || 'databricks';
  const env = cliEnv(o.env || process.env);
  const now = o.now || (() => Date.now());
  const loginTimeoutMs = o.loginTimeoutMs || LOGIN_TIMEOUT_MS;
  const log = o.log || (() => {});
  const tokens = new Map(); // profile → {token, expiresAt}; memory only
  const logins = new Map(); // profile → in-flight login promise
  let info = null;
  let infoAt = 0;

  async function cliInfo({ fresh = false } = {}) {
    if (!fresh && info && now() - infoAt < CLI_INFO_TTL_MS) return info;
    let out;
    try {
      const r = await runCli(cliPath, ['--version'], { timeoutMs: VERSION_TIMEOUT_MS, env });
      const v = r.code === 0 ? parseCliVersion(r.stdout || r.stderr) : null;
      out = v ? { found: true, version: v.text, supported: isSupportedVersion(v) } : { found: true, version: null, supported: false };
    } catch (_) {
      out = { found: false, version: null, supported: false };
    }
    info = out;
    infoAt = now();
    return out;
  }

  async function assertCli() {
    const c = await cliInfo();
    if (!c.found) throw new errors.DccError({ code: 'HELPER_CLI_MISSING', message: 'Databricks CLI not found. Install it, or set DCC_DATABRICKS_CLI to its path, then restart the helper.' });
    if (!c.supported) {
      info = null; // re-check after the user updates
      throw new errors.DccError({ code: 'HELPER_CLI_MISSING', message: 'Databricks CLI ' + (c.version ? 'v' + c.version : '(unknown version)') + ' is older than v' + MIN_CLI_VERSION.join('.') + '.' });
    }
    return c;
  }

  /** Current CLI session for a profile, or null when not signed in. Keeps only access_token + expiry. */
  async function readToken(profile) {
    let r;
    try {
      r = await runCli(cliPath, ['auth', 'token', '--profile', profile], { timeoutMs: TOKEN_TIMEOUT_MS, env });
    } catch (e) {
      throw new errors.DccError({ code: 'HELPER_CLI_MISSING', message: 'Databricks CLI could not be started.' });
    }
    if (r.code !== 0 || r.timedOut) return null;
    let token = null;
    let expiresAt = null;
    try {
      const parsed = JSON.parse(r.stdout);
      token = parsed && typeof parsed.access_token === 'string' && parsed.access_token.length >= 8 ? parsed.access_token : null;
      if (parsed && parsed.expiry !== undefined && parsed.expiry !== null && parsed.expiry !== '') {
        const ms = Date.parse(String(parsed.expiry));
        expiresAt = Number.isFinite(ms) ? ms : NaN;
      }
    } catch (_) {
      return null;
    }
    if (!token) return null;
    if (Number.isNaN(expiresAt)) return null;
    if (expiresAt !== null && expiresAt <= now() + TOKEN_SKEW_MS) return null;
    // Without an expiry the CLI manages refresh itself; reuse for at most five minutes.
    return { token, expiresAt: expiresAt === null ? now() + 5 * 60000 : expiresAt };
  }

  /** Access token for (origin, purpose). Throws AUTH_EXPIRED when the profile is not signed in. */
  async function getToken(origin, purpose = 'cost') {
    const profile = profileName(origin, purpose);
    const cached = tokens.get(profile);
    if (cached && cached.expiresAt - TOKEN_SKEW_MS > now()) return cached.token;
    tokens.delete(profile);
    await assertCli();
    const t = await readToken(profile);
    if (!t) {
      throw new errors.DccError({
        code: 'AUTH_EXPIRED',
        message: (purpose === 'monitor' ? 'Monitor sign-in' : 'Browser sign-in') + ' is missing or expired for this workspace. Open Connection preferences and select Sign in with browser.',
      });
    }
    tokens.set(profile, t);
    return t.token;
  }

  /** Reuse a valid session, otherwise run interactive OAuth with the purpose's scope. */
  async function login(origin, purpose = 'cost') {
    const cls = workspaceOrigin(origin);
    const profile = profileName(cls.origin, purpose);
    await assertCli();
    const existing = await readToken(profile);
    if (existing) {
      tokens.set(profile, existing);
      return { signedIn: true, reused: true, profile };
    }
    if (logins.has(profile)) return logins.get(profile);
    const p = (async () => {
      tokens.delete(profile);
      log('Opening browser sign-in for ' + cls.host + ' (' + purpose + ', Databricks CLI profile ' + profile + ')');
      let r;
      try {
        r = await runCli(cliPath, ['auth', 'login', '--host', cls.origin, '--profile', profile, '--scopes', SCOPES[purpose]], {
          timeoutMs: loginTimeoutMs,
          env,
          onLine: (line) => log('  cli: ' + errors.redact(line).slice(0, 300)),
        });
      } catch (e) {
        throw new errors.DccError({ code: 'HELPER_CLI_MISSING', message: 'Databricks CLI could not be started.' });
      }
      if (r.timedOut) throw new errors.DccError({ code: 'AUTH_EXPIRED', message: 'Browser sign-in timed out after ' + Math.round(loginTimeoutMs / 1000) + ' seconds.' });
      if (r.code !== 0) {
        const last = (r.stderr || '').split(/\r?\n/).map((l) => l.trim()).filter((l) => /^Error:/.test(l)).pop();
        throw new errors.DccError({ code: 'AUTH_EXPIRED', message: 'Browser sign-in did not complete.' + (last ? ' ' + errors.redact(last).slice(0, 200) : '') });
      }
      const t = await readToken(profile);
      if (!t) throw new errors.DccError({ code: 'AUTH_EXPIRED', message: 'Sign-in finished but the CLI has no valid session for this workspace.' });
      tokens.set(profile, t);
      return { signedIn: true, reused: false, profile };
    })();
    logins.set(profile, p);
    try {
      return await p;
    } finally {
      logins.delete(profile);
    }
  }

  /** Drop a cached token (e.g. after Databricks answered 401). */
  function forget(origin, purpose = 'cost') {
    try {
      tokens.delete(profileName(origin, purpose));
    } catch (_) {
      /* invalid origin: nothing cached */
    }
  }

  return { cliInfo, assertCli, getToken, login, forget, profileName, cliPath };
}
