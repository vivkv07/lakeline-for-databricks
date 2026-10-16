#!/usr/bin/env node
/*
 * DEV-ONLY launch-video server: the SYNTHETIC "Northpeak Retail" workspaces over HTTPS on one
 * local port, dispatched by Host header. Not part of the distributable.
 *
 *   node local/video/video-server.mjs [--port 8443]
 *
 * Hosts (point them at 127.0.0.1:<port> in the capture browser with --host-resolver-rules; never
 * edit /etc/hosts):
 *   northpeak-prod.cloud.databricks.com        full story dataset (local/video/story-data.mjs)
 *   northpeak-analytics.cloud.databricks.com   smaller marketing workspace
 *   northpeak-dev.cloud.databricks.com         lightweight (workspace-colors scene)
 *   northpeak-stage.cloud.databricks.com       lightweight (workspace-colors scene)
 *   videos.example                             neutral synthetic video page ("other work")
 *   docs.example                               neutral synthetic doc editor ("other work")
 * Each workspace is one createFixtureApp (local/fixture-server.mjs): routed SPA shell
 * (local/video/shell.html), templated fragments (local/video/fragments/), the mock REST API, the
 * extension's SQL on DuckDB (SIMULATION), the Genie Conversation API mock with answers computed
 * from the same engine, and monitor data. Every /api/ request needs that workspace's FAKE token
 * (WORKSPACES[*].token in story-data.mjs); none of them is a credential.
 *
 * /oidc/v1/authorize and /oidc/v1/token on each workspace host are a mock OIDC provider for the
 * popup's real one-click sign-in (see oidc() below); the issued access token is that workspace's
 * fake token.
 *
 * TLS: a throwaway self-signed certificate for exactly these hosts is generated at start with the
 * openssl CLI into a fresh temp directory, which is deleted on close. No key is ever written to
 * the repository. The capture browser runs with --ignore-certificate-errors (disposable profile).
 * Binds 127.0.0.1 only; any other Host header is refused (403).
 */
import https from 'node:https';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { createFixtureApp } from '../fixture-server.mjs';
import { WORKSPACES, RESOURCES, GENIE_SPACES, buildStoryDataset, storyTemplateValues, storyMonitorSnapshot, prepareGenie } from './story-data.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
/** The only OAuth client ID the mock OIDC endpoint accepts (synthetic). */
export const VIDEO_OAUTH_CLIENT_ID = 'northpeak-lakeline-video';
export const OTHER_HOSTS = Object.freeze({ videos: 'videos.example', docs: 'docs.example' });
const PAGES = Object.freeze({
  [OTHER_HOSTS.videos]: path.join(HERE, 'pages', 'video.html'),
  [OTHER_HOSTS.docs]: path.join(HERE, 'pages', 'doc.html'),
});
const SEC_HEADERS = { 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'no-referrer' };

function plain(res, status, text) {
  const buf = Buffer.from(text, 'utf8');
  res.writeHead(status, Object.assign({ 'Content-Type': 'text/plain; charset=utf-8', 'Content-Length': buf.length }, SEC_HEADERS));
  res.end(buf);
}

/** Self-signed certificate for `hosts` in a new temp dir (openssl CLI). */
function makeCert(hosts) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lakeline-video-tls-'));
  const key = path.join(dir, 'key.pem');
  const cert = path.join(dir, 'cert.pem');
  execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', key, '-out', cert, '-days', '2', '-subj', '/CN=lakeline-video-capture (synthetic, local only)', '-addext', 'subjectAltName=' + hosts.map((h) => 'DNS:' + h).join(',')], { stdio: 'ignore' });
  return { dir, key: fs.readFileSync(key), cert: fs.readFileSync(cert) };
}

/**
 * @param {object} [o]
 * @param {number} [o.port=0]           0 → ephemeral
 * @param {number} [o.nowMs]            dataset anchor (default: now)
 * @param {string[]} [o.workspaces]     subset of Object.keys(WORKSPACES)
 * @param {number} [o.genieStepPolls=2] message polls per Genie status (keeps "working" visible)
 * @param {Function} [o.onApiRequest]   ({host, method, path, body}) for every authorized /api/ call
 * @param {Function} [o.log]
 */
export async function startVideoServer(o = {}) {
  const log = o.log || ((line) => process.stderr.write('[video-server] ' + line + '\n'));
  const keys = o.workspaces || Object.keys(WORKSPACES);
  const live = Object.fromEntries(keys.map((k) => [k, {}]));
  const apps = {};
  const genie = {};
  for (const key of keys) {
    const W = WORKSPACES[key];
    const holder = { answer: null };
    apps[key] = await createFixtureApp({
      nowMs: o.nowMs,
      log,
      token: W.token,
      origin: W.origin,
      genieStepPolls: o.genieStepPolls || 2,
      onApiRequest: o.onApiRequest ? (r) => o.onApiRequest(Object.assign({ host: W.host }, r)) : undefined,
      data: {
        buildDataset: ({ nowMs }) => buildStoryDataset(key, { nowMs }),
        fixtureTemplateValues: storyTemplateValues,
        monitorSnapshot: (nowMs, origin) => storyMonitorSnapshot(key, Date.now(), origin, live[key]),
        WAREHOUSES: RESOURCES[key].warehouses,
        GENIE_SPACES: GENIE_SPACES[key],
        GENIE_FAILING_SPACE: null,
        genieAnswer: (spaceId, question) => holder.answer(spaceId, question),
      },
      afterLoad: async ({ engine, dataset }) => {
        genie[key] = await prepareGenie(engine, dataset);
        holder.answer = genie[key].genieAnswer;
      },
      staticDirs: [path.join(HERE, 'static'), path.resolve(HERE, '..')],
      fragmentDirs: [path.join(HERE, 'fragments', key === 'prod' ? 'prod' : 'small'), path.join(HERE, 'fragments', 'common')],
      shellFile: path.join(HERE, 'shell.html'),
      shellTemplate: true,
    });
  }
  const byHost = new Map(keys.map((k) => [WORKSPACES[k].host, apps[k]]));

  /*
   * Mock OIDC for the popup's one-click "Sign in with Databricks" (authorization code + PKCE
   * S256, as extension/src/background/oauth.js runs it through chrome.identity.launchWebAuthFlow).
   * The authorize step redirects straight back (an already signed-in, already consented user);
   * the token step checks the code, client, redirect URI and PKCE verifier and returns the
   * workspace's FAKE token as the access token. Only VIDEO_OAUTH_CLIENT_ID is accepted.
   */
  const codes = new Map();
  async function oidc(req, res, key) {
    const W = WORKSPACES[key];
    const url = new URL(req.url, W.origin);
    const json = (status, obj) => {
      const buf = Buffer.from(JSON.stringify(obj));
      res.writeHead(status, Object.assign({ 'Content-Type': 'application/json', 'Content-Length': buf.length }, SEC_HEADERS));
      res.end(buf);
    };
    if (req.method === 'GET' && url.pathname === '/oidc/v1/authorize') {
      const q = url.searchParams;
      const redirect = q.get('redirect_uri') || '';
      if (q.get('client_id') !== VIDEO_OAUTH_CLIENT_ID || !/^https:\/\/[a-p]{32}\.chromiumapp\.org\/$/.test(redirect) || q.get('response_type') !== 'code' || q.get('code_challenge_method') !== 'S256' || !q.get('code_challenge') || !q.get('state')) return json(400, { error: 'invalid_request' });
      const code = crypto.randomBytes(16).toString('hex');
      codes.set(code, { key, clientId: q.get('client_id'), redirect, challenge: q.get('code_challenge'), scope: q.get('scope') || '', at: Date.now() });
      res.writeHead(302, Object.assign({ Location: redirect + '?code=' + code + '&state=' + encodeURIComponent(q.get('state')), 'Content-Length': 0 }, SEC_HEADERS));
      return res.end();
    }
    if (req.method === 'POST' && url.pathname === '/oidc/v1/token') {
      const chunks = [];
      for await (const c of req) chunks.push(c);
      const form = new URLSearchParams(Buffer.concat(chunks).toString('utf8'));
      if (form.get('client_id') !== VIDEO_OAUTH_CLIENT_ID) return json(401, { error: 'invalid_client' });
      if (form.get('grant_type') === 'authorization_code') {
        const c = codes.get(form.get('code') || '');
        codes.delete(form.get('code') || '');
        const verifier = form.get('code_verifier') || '';
        const challenge = crypto.createHash('sha256').update(verifier).digest('base64url');
        if (!c || c.key !== key || c.redirect !== form.get('redirect_uri') || c.challenge !== challenge || Date.now() - c.at > 120000) return json(400, { error: 'invalid_grant' });
        oauthLog.push({ host: W.host, grant: 'authorization_code', scope: c.scope });
        return json(200, { access_token: W.token, refresh_token: 'video-refresh-' + crypto.randomBytes(8).toString('hex'), token_type: 'Bearer', expires_in: 3600, scope: c.scope });
      }
      if (form.get('grant_type') === 'refresh_token' && /^video-refresh-[0-9a-f]{16}$/.test(form.get('refresh_token') || '')) {
        oauthLog.push({ host: W.host, grant: 'refresh_token' });
        return json(200, { access_token: W.token, token_type: 'Bearer', expires_in: 3600 });
      }
      return json(400, { error: 'unsupported_grant_type' });
    }
    return json(404, { error: 'not_found' });
  }
  const oauthLog = [];
  const hosts = keys.map((k) => WORKSPACES[k].host).concat(Object.values(OTHER_HOSTS));
  const tls = makeCert(hosts);

  async function handle(req, res) {
    const host = String(req.headers.host || '').toLowerCase().replace(/:443$/, '');
    const app = byHost.get(host);
    if (app && (req.url || '').startsWith('/oidc/v1/')) return oidc(req, res, keys.find((k) => WORKSPACES[k].host === host));
    if (app) return app.handle(req, res);
    if (PAGES[host]) {
      if (req.method !== 'GET' && req.method !== 'HEAD') return plain(res, 405, '');
      const p = (req.url || '/').split('?')[0];
      if (p === '/favicon.ico') return plain(res, 404, '');
      const body = fs.readFileSync(PAGES[host]);
      res.writeHead(200, Object.assign({ 'Content-Type': 'text/html; charset=utf-8', 'Content-Length': body.length }, SEC_HEADERS));
      return res.end(req.method === 'HEAD' ? undefined : body);
    }
    return plain(res, 403, 'Forbidden');
  }

  const server = https.createServer({ key: tls.key, cert: tls.cert, requestTimeout: 60000, headersTimeout: 10000 }, (req, res) => {
    handle(req, res).catch((e) => {
      log('request failed: ' + String((e && e.message) || e).slice(0, 200));
      if (!res.headersSent) plain(res, 500, '');
    });
  });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(o.port || 0, '127.0.0.1', () => {
      server.off('error', reject);
      resolve();
    });
  });
  const port = server.address().port;
  return {
    server,
    port,
    hosts,
    apps,
    genie,
    live,
    oauthLog,
    /** Chromium flag value mapping every host to this server. */
    resolverRules: () => hosts.map((h) => 'MAP ' + h + ' 127.0.0.1:' + port).join(', '),
    close: () =>
      new Promise((resolve) => {
        server.close(() => resolve());
        server.closeAllConnections && server.closeAllConnections();
        fs.rmSync(tls.dir, { recursive: true, force: true });
      }),
  };
}

function isMain() {
  try {
    return Boolean(process.argv[1]) && fs.realpathSync(process.argv[1]) === fs.realpathSync(fileURLToPath(import.meta.url));
  } catch (_) {
    return false;
  }
}

if (isMain()) {
  const argv = process.argv.slice(2);
  const i = argv.indexOf('--port');
  startVideoServer({ port: i >= 0 ? Number(argv[i + 1]) : 8443 })
    .then((v) => {
      process.stdout.write('Launch-video server (SYNTHETIC, dev only) on https://127.0.0.1:' + v.port + '\nChromium flags:\n  --host-resolver-rules="' + v.resolverRules() + '" --ignore-certificate-errors\nCtrl+C to stop.\n');
      const stop = () => v.close().then(() => process.exit(0));
      process.on('SIGINT', stop);
      process.on('SIGTERM', stop);
    })
    .catch((e) => {
      process.stderr.write('Video server failed to start: ' + String((e && e.message) || e) + '\n');
      process.exit(1);
    });
}
