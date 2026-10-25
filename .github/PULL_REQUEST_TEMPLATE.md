## What this changes

<!-- One or two sentences. Link the issue: Fixes #123 -->

## How it was tested

<!-- npm test, npm run test:browser, manual steps in Demo mode or against the local fixture -->

## Checklist

- [ ] Every commit is signed off (`git commit -s`), see [CONTRIBUTING.md](../CONTRIBUTING.md#sign-off-your-commits-dco)
- [ ] `npm test` passes; `npm run test:browser` too if UI or content scripts changed
- [ ] Synthetic data only: no real workspace URLs, IDs, tokens, costs, names or screenshots
- [ ] No new network destinations, permissions, remote code or `eval`. If this touches
      `manifest.json`, sign-in, secrets, the message router or packaging, the reason is explained above
- [ ] UI text is plain and short, with no em dashes; amounts are labeled as estimates
- [ ] `CHANGELOG.md` updated
