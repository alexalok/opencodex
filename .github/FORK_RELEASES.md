# Manual fork releases

`fork-release.yml` builds the package and provenance consumed by the updater on
managed installations. It only publishes GitHub Releases in `alexalok/opencodex`.
It never publishes to npm, deploys to the host, bumps versions, or promotes branches.

## Before running

1. Integrate the intended code and stable `X.Y.Z` version through the fork's
   normal review and promotion process. Keep the version sources synchronized.
2. Ensure the workflow and its helper are present on the repository's default
   branch. GitHub's manual **Run workflow** button requires this. The release
   source must be on that branch, matching the updater's ancestry check.
3. Wait for **Cross-platform CI** on the default branch's exact push commit to
   succeed. A PR run, a different commit, or a manual CI lane does not qualify.
4. Copy the complete 40-character commit SHA. The requested version must match
   its `package.json`, including the committed `opencodexFork.repository` field.
   Any existing `vX.Y.Z` tag must already point to that exact commit.

Private backports are not promoted by this workflow. A host update needs a
newer stable release from code promoted to the default branch.

## Run from GitHub Actions

Open **Actions → Fork release → Run workflow**, select the default branch,
enter `version` and `expected-sha`, and leave **dry-run** checked first.

The dry run installs the frozen Bun dependency graphs with the existing
nine-day development dependency-age policy, performs type/security/structure
checks, builds the dashboard, and uses the canonical package preparation
command. It uploads a 14-day Actions artifact containing:

- `opencodex-X.Y.Z-alexalok.tgz`
- `provenance.json`, with the artifact filename, version, SHA-256, source
  commit, and fork repository URL.

If Bun's npm launchers remain placeholders, initialization copies only the
already-installed, version-checked platform binary. A missing binary fails the
build; initialization never invokes npm or downloads a replacement.

After reviewing a successful dry run, dispatch the same commit/version with
**dry-run** unchecked. A separate job with `contents: write` verifies the
bundle, source ancestry, and exact-commit CI again. It creates the exact tag
if absent, uploads both assets to a draft, verifies GitHub's SHA-256 digests
and sizes, and publishes the complete stable release.

The publishing job does not install dependencies or execute package content.
The build job has no write token or repository secrets. Both checkouts avoid
persisting credentials; third-party actions are pinned to immutable commits.

The equivalent CLI dispatch is:

```sh
gh workflow run fork-release.yml --repo alexalok/opencodex --ref main \
  -f version=X.Y.Z -f expected-sha=FULL_COMMIT_SHA -F dry-run=true
```

Substitute the actual default branch if it changes. Set `dry-run=false` only
when publication is intended. No scheduled or push trigger publishes a release.

## Failure and retry

Existing published releases and drafts are never overwritten. An upload or
verification failure leaves its draft and possibly a newly created tag for
inspection. Inspect the failed run and draft before explicitly removing a
failed draft or selecting a new version; do not replace a published asset.
An existing matching tag can be reused when no release or draft exists.

A rerun of only a failed publishing job may lack the artifact for its new run
attempt. Rerun all jobs, or dispatch a fresh dry run, after addressing the
failure. Artifacts from unrelated runs are not accepted.

The host still waits seven days after publication and both asset upload/update
times before installing a newer version. Its separate pnpm dependency-age,
lifecycle-script, backup, health-check, and rollback policies remain in force.

## Local contract checks

```sh
python3 .github/scripts/test_fork_release.py -v
actionlint .github/workflows/fork-release.yml
```

These checks exercise dispatch/CI gates, package identity and archive safety,
provenance integrity, draft publication, and upload-failure handling. They do
not prove that a GitHub Actions run succeeded; that requires a real dry run
after the workflow has landed on the default branch.
