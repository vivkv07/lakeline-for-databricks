# Contributing to Lakeline for Databricks

Thanks for helping. Lakeline is created and maintained by Vivek Kovvuru. Bug reports, fixes,
docs and ideas are welcome.

## Before you start

- **Bugs and small fixes:** open a pull request, or an issue first if you're unsure.
- **New features:** open an issue describing the problem first, so we agree on the approach before
  you write code.
- **Security problems:** don't open an issue. Follow [SECURITY.md](SECURITY.md).

## Set up

You need Node.js 20 or newer.

```bash
npm ci
npm test
```

- `npm test` runs the simulated suite: unit tests, the DuckDB SQL engine and the jsdom UI tests.
- `npm run test:browser` runs the extension in a real Chromium against the local fixture (needs
  Playwright's Chromium). `npm run test:edge` runs the same suite in an installed Microsoft Edge.
- `npm run fixture` starts a synthetic workspace at http://127.0.0.1:8765 for trying changes by hand.
- Load `extension/` unpacked from `chrome://extensions` or `edge://extensions` (Developer mode,
  Load unpacked).

Tests never touch a real Databricks workspace. Keep it that way.

## Pull request checklist

- One focused change per pull request, with tests for new behavior.
- `npm test` passes. Run `npm run test:browser` too if you changed UI or content scripts.
- Use synthetic data only. Never commit real workspace URLs, IDs, tokens, costs, names or
  screenshots of a real workspace (including Databricks Free Edition and employer workspaces).
- Don't add Databricks logos or other Databricks brand assets, and don't describe Lakeline as
  official, certified or endorsed by Databricks. See [TRADEMARKS.md](TRADEMARKS.md).
- UI text: plain, short, active voice, no em dashes. Every amount is labeled as an estimate.
- Add a line to `CHANGELOG.md` under the next version.
- Sign off every commit (see below).

## Changes that get extra review

Lakeline holds Databricks sign-in tokens, so these areas are reviewed line by line, and changes to
them need a clear reason in the pull request:

- `extension/manifest.json`: permissions, host permissions, `externally_connectable`, content
  security policy, web-accessible resources.
- `extension/src/background/`: sign-in (`oauth.js`), secrets, the message router and sender checks,
  and anything that makes network requests.
- Anything that renders text from Databricks or Genie as HTML.
- SQL builders under `extension/src/databricks/queries/`: queries stay read-only and parameterized.
- `package.json` and `package-lock.json`: new dependencies or scripts.
- `scripts/package.mjs` and anything under `.github/`.

Requests go only to the user's own workspace (and, when the user opts in, the local helper). A
pull request that adds any other network destination, remote code or `eval` won't be merged.

## Sign off your commits (DCO)

This project uses the [Developer Certificate of Origin](DCO) instead of a contributor license
agreement. By signing off, you confirm that you wrote the change or otherwise have the right to
submit it under the project's license.

Add a sign-off line to every commit with `-s`:

```bash
git commit -s -m "Fix the period selector label"
```

That adds a line with your name and email:

```
Signed-off-by: Your Name <you@example.com>
```

The name and email must match the commit's author. A check on every pull request looks for it.
To fix commits you already made:

```bash
git rebase --signoff main
git push --force-with-lease
```

## How your contribution ships

1. **Start:** open an issue for a feature (so we agree on the approach first), or go straight to a
   pull request for a fix. Issues labeled `good first issue` are a good place to begin.
2. **Build it:** fork the repository, create a branch, and commit with `git commit -s`.
3. **Open a pull request:** the template asks what changed, how you tested it, and a short
   checklist. Fill it in; it saves a review round.
4. **Checks run:** CI runs the tests and the packaging secret scan, and the DCO check confirms
   every commit is signed off. Workflows from first-time contributors wait for the maintainer to
   approve them, which is a GitHub safety default.
5. **Review:** the maintainer reviews every pull request (code owner approval is required). Expect
   questions or change requests; resolve each conversation before merge.
6. **Merge:** the change lands on `main` and is listed under "Unreleased" in `CHANGELOG.md`.
7. **Release:** the maintainer cuts the next version and publishes it to the Chrome Web Store and
   Microsoft Edge Add-ons, as described in [RELEASING.md](RELEASING.md). Store review takes from a
   few days to a few weeks. The release notes credit your GitHub handle.

## Licensing and credit

- Contributions are licensed under the [Apache License 2.0](LICENSE), the same license as the rest
  of the project. You keep the copyright to your contribution.
- Your name stays in the git history, and notable contributions are credited in the release notes.
- The maintainer decides what is merged and when releases ship. Only the maintainer publishes
  Lakeline to the Chrome Web Store and Microsoft Edge Add-ons.
- The Lakeline name and icon aren't covered by the code license. See [TRADEMARKS.md](TRADEMARKS.md).

## Conduct

Be respectful and assume good intent. Harassment or personal attacks in issues, pull requests or
reviews aren't accepted, and the maintainer may remove such content or block the account.
