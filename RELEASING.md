# Releasing Lakeline

How a merged change reaches users. Only the maintainer (Vivek Kovvuru) publishes Lakeline to the
Chrome Web Store and Microsoft Edge Add-ons. Contributors don't need to do anything here: a merged
pull request ships in the next release, and the release notes credit you.

## 1. Choose the version

Lakeline follows [Semantic Versioning](https://semver.org): a patch release (0.1.**2**) for fixes, a
minor release (0.**2**.0) for new features. Set the same version in three places:

- `extension/manifest.json` (`version`)
- `package.json` (`version`)
- `package-lock.json` (the root `version` and `packages[""].version`)

## 2. Update the changelog

In `CHANGELOG.md`, rename `## [Unreleased]` to `## [x.y.z] (YYYY-MM-DD)` and start a new empty
`## [Unreleased]` above it. Credit outside contributors by GitHub handle, for example
"Thanks @someone".

## 3. Verify

```bash
npm ci
npm test
npm run test:browser
npm run test:edge
```

`npm run test:edge` needs Microsoft Edge installed; skip it otherwise. Then check by hand:

- **Demo mode:** banner, Explorer, monitor and Ask Genie.
- **A real workspace you own:** Sign in with Databricks, the cost banner and one Genie question.
- **A token connection:** Other ways to sign in, Use a personal access token.

## 4. Build the store package

```bash
node scripts/package.mjs --store
```

This writes `dist/lakeline-for-databricks-store-x.y.z.zip`. The packager:

- includes only allowlisted files;
- removes the development `key` and the developer-only flags;
- adds LICENSE and NOTICE;
- refuses tokens, keys and real workspace hosts.

Before uploading, also:

- Check the archive: `python3 -m zipfile -t dist/lakeline-for-databricks-store-x.y.z.zip`.
- Compare `manifest.json` permissions with the previous release. Any new permission needs:
  - a justification in `store/LISTING.md` and in the Chrome Web Store Privacy tab;
  - an update to `docs/privacy.html`.
- If the UI changed, regenerate the store images: `npm run video:capture`, then
  `npm run store:assets`.

## 5. Publish

Field-by-field values are in [store/LISTING.md](store/LISTING.md) (Chrome) and
[store/edge/LISTING.md](store/edge/LISTING.md) (Edge).

- **Chrome Web Store:** Developer Dashboard, the item, then:
  1. Package, Upload new package. Choose the ZIP.
  2. Update the Store listing and Privacy tabs if anything changed.
  3. Submit for review.
- **Microsoft Edge Add-ons:** Partner Center, the extension, Packages. Upload the same ZIP, update
  the listing if needed, then Publish.

Reviews take from a few days to a few weeks. Publish to a hidden or unlisted audience first when a
release changes sign-in or permissions.

## 6. Tag and announce

```bash
git tag vx.y.z
git push origin vx.y.z
gh release create vx.y.z dist/lakeline-for-databricks-store-x.y.z.zip --title "Lakeline x.y.z" --notes "<the changelog section>"
```

## Safety rules

- Build and upload only from your own machine, from a reviewed commit on `main`. Never from CI and
  never from someone else's build.
- Keep 2-step verification on the Google, Microsoft and GitHub accounts that can publish.
- On the Chrome Web Store Package page, opt in to **Verified CRX uploads**, so a stolen password
  alone can't publish an update.
