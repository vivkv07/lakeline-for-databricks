# Security policy

Lakeline handles Databricks sign-in tokens and runs inside Databricks workspaces, so security
reports get priority.

## Report a vulnerability privately

Please do **not** open a public issue for a security problem.

Report it here instead:
https://github.com/vivkv07/lakeline-for-databricks/security/advisories/new

Only the maintainer can see the report. Please include:

- what an attacker could do, and what they need first (a malicious page, a workspace account,
  local access);
- steps to reproduce, with the Lakeline version (`chrome://extensions` or `edge://extensions`) and
  browser version;
- a proof of concept if you have one.

Never include real access tokens, workspace URLs you don't own, or customer data. Use Demo mode or
the local fixture (`npm run fixture`) to reproduce.

## What happens next

- I acknowledge reports within 5 business days.
- I confirm or rule out the issue and agree a fix timeline with you.
- Fixes ship as a new store version. The advisory is published after the fixed version is live,
  with credit to you unless you prefer to stay anonymous.

## Supported versions

Only the latest version in the Chrome Web Store and Microsoft Edge Add-ons gets fixes. Store
installs update automatically.

## In scope

- The extension in `extension/`: background service worker, content scripts, popup, options,
  side panel and monitor window.
- The optional local helper in `local/` (`server.mjs`, the setup page).
- The build and packaging scripts in `scripts/`.

## Out of scope

- Vulnerabilities in Databricks itself. Report those to Databricks.
- Problems that need a compromised computer or browser profile.
- Missing hardening with no concrete attack, such as a header suggestion on the GitHub Pages site.

## Safe harbor

Good-faith research that follows this policy, avoids privacy violations and service disruption,
and uses only accounts and workspaces you own is welcome. I won't pursue or support legal action
over it.
