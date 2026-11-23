# Maintainers and governance

## Who maintains Lakeline

| Role | Person | Scope |
|---|---|---|
| Owner and sole maintainer | [@vivkv07](https://github.com/vivkv07) (Vivek Kovvuru) | All code, releases, store listings, security reports, trademark |

`.github/CODEOWNERS` lists the same person for every path, so every pull request needs the
owner's approval before it can merge.

## How decisions are made

- The maintainer decides what is merged, what ships and when. Discussion is welcome, and good
  reasons change minds, but there is no vote.
- A change is accepted when it fits the extension's purpose (cost context, run status and Genie
  answers inside a Databricks workspace), stays read-only and local, adds no analytics or
  third-party servers, and comes with tests.
- Changes that widen permissions, touch sign-in or token storage, or alter what leaves the
  browser need extra scrutiny and an update to `docs/privacy.html` and the store listing.

## Rules for contributors

All of these are enforced by CI or branch protection on `main`:

- Every commit is signed off (`git commit -s`), per the [DCO](DCO). The `dco` check fails otherwise.
- `npm test` passes. The `test` check is required.
- Pull requests go through review by a code owner; stale approvals are dismissed after new pushes;
  conversations must be resolved; force pushes and deleting `main` are blocked.
- No secrets, real workspace hostnames, Free Edition captures or customer data in commits,
  screenshots or fixtures.

## Releases

Only the maintainer builds and publishes releases, from `main`, on their own machine, following
[RELEASING.md](RELEASING.md). Releases are tagged `vX.Y.Z` with notes taken from
[CHANGELOG.md](CHANGELOG.md).

## Continuity

If the maintainer is unavailable for an extended period:

- The Chrome Web Store and Edge Add-ons listings and the GitHub repository stay as they are. The
  extension keeps working; only updates pause.
- The Apache-2.0 license lets anyone fork the code. A fork must use a different name and icon
  ([TRADEMARKS.md](TRADEMARKS.md)).
- To propose a co-maintainer, open an issue. Co-maintainers are added only by the owner, after a
  record of good contributions, and receive the minimum access needed.

## Changing this page

Changes to governance, CODEOWNERS or branch protection are made by the maintainer through a pull
request like any other change.
