# Fork release version checks

`scripts/lib/release-version-policy.ts` selects the tag set used by
`tests/ci-workflows/release-version-line.test.ts`.

An explicit `package.json.opencodexFork.repository` pointing to a GitHub fork of
OpenCodex scopes the local check to release tags merged into `HEAD`. Unmerged
upstream tags do not force a backport checkout onto a different release line.
The upstream repository and missing or malformed fork metadata keep the global
tag check. Version ordering and the equal-version release-commit check stay intact.

This is a local ancestry check, not publication authorization. The authoritative
remote-tag, registry, exact-commit, CI, and explicit publication gates in
`scripts/release.ts` remain unchanged. No version bump or release occurs here.
