#!/usr/bin/env bash
# Databricks Cost Companion: start the local helper (macOS and Linux).
#
# - Needs Node.js 20 or newer. Browser sign-in also needs the Databricks CLI v1.12 or newer.
# - If a helper of the same version is already running, it is reused: this script asks it to
#   reopen the setup page and exits. The pairing key is never printed.
# - If an older helper is running, this script explains how to stop it and exits.
# - Otherwise it starts `node local/server.mjs --open` in this window. Press Ctrl+C to stop.
set -u

DIR="$(cd "$(dirname "$0")" && pwd)"
cd "$DIR" || exit 1
# Double-clicked scripts may not see Homebrew or user-installed tools.
export PATH="$PATH:/opt/homebrew/bin:/usr/local/bin"

# The extension pairs with port 8766. DCC_HELPER_PORT exists only for automated tests.
PORT="${DCC_HELPER_PORT:-8766}"
BASE="http://127.0.0.1:${PORT}"

if ! command -v node >/dev/null 2>&1; then
  echo "Node.js 20 or newer is required but was not found. Install it from https://nodejs.org and run this script again." >&2
  exit 1
fi
NODE_MAJOR="$(node -p 'process.versions.node.split(".")[0]' 2>/dev/null || echo 0)"
if [ "${NODE_MAJOR:-0}" -lt 20 ] 2>/dev/null; then
  echo "Node.js 20 or newer is required (found $(node --version 2>/dev/null)). Update Node.js and run this script again." >&2
  exit 1
fi

WANT="$(node local/server.mjs --version)" || { echo "Could not read the helper version." >&2; exit 1; }

HEALTH=""
if command -v curl >/dev/null 2>&1; then
  HEALTH="$(curl -s --max-time 3 "${BASE}/health" 2>/dev/null || true)"
fi

if [ -n "$HEALTH" ]; then
  RUNNING="$(printf '%s' "$HEALTH" | node -e '
    let s = "";
    process.stdin.on("data", (d) => (s += d)).on("end", () => {
      try {
        const j = JSON.parse(s);
        if (j && j.name === "dcc-helper" && typeof j.version === "string" && /^[0-9.]+$/.test(j.version)) process.stdout.write(j.version);
      } catch (_) {}
    });' 2>/dev/null || true)"

  if [ -n "$RUNNING" ] && [ "$RUNNING" = "$WANT" ]; then
    if curl -s --max-time 10 -X POST -H "X-DCC-Launcher: 1" "${BASE}/launcher/open-setup" | grep -q '"opened":true'; then
      echo "The helper (${RUNNING}) is already running. The setup page was reopened in your browser."
      exit 0
    fi
    echo "The helper (${RUNNING}) is already running, but it could not open a browser. Try again in a few seconds." >&2
    exit 1
  fi

  if [ -n "$RUNNING" ]; then
    echo "An older helper (${RUNNING}) is still running on port ${PORT}; this folder has version ${WANT}." >&2
    echo "Stop the old helper first: switch to its terminal window and press Ctrl+C (or close that window)." >&2
    echo "If you cannot find it, run:  lsof -nP -iTCP:${PORT} -sTCP:LISTEN   and stop that node process." >&2
    echo "Then run this script again. Afterwards, reconnect from the extension (Connection preferences)." >&2
    exit 2
  fi

  echo "Port ${PORT} is in use by another program, so the helper cannot start." >&2
  echo "Find it with:  lsof -nP -iTCP:${PORT} -sTCP:LISTEN" >&2
  exit 3
fi

exec node local/server.mjs --open --port "$PORT" "$@"
