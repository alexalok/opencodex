# Maintainers

For `alexalok/opencodex`, the owner-directed fork workflow in
[`AGENTS.md`](./AGENTS.md#git-workflow-for-alexalokopencodex) governs integration:
PRs into current `dev`, synchronization to the upstream tip fetched and pinned
at the start of the integration process, and PRs from `backports/vX.Y.Z/*` into
`releases/vX.Y.Z`. Fork `dev` must contain that pinned commit before the requested
PR merges; a prerequisite sync PR includes it and is integrated with a merge
commit. Later upstream advances during CI, review, or merge do not require
restarting the process. There is no fork `main` or separate stable line. The owner may explicitly authorize fork integration after validation
and security review. The upstream roster and promotion rules below describe
`lidge-jun/opencodex`; they do not grant permissions in this fork.

This document lists the people responsible for maintaining opencodex and defines the project's
review and merge policy.

## Current maintainers

| GitHub account | Project role | Responsibilities |
| --- | --- | --- |
| [@lidge-jun](https://github.com/lidge-jun) | Project owner | Project direction, releases, repository administration, and final governance decisions |
| [@Ingwannu](https://github.com/Ingwannu) | Maintainer | Issue and pull-request triage, `dev` integration, security review, and repository maintenance |

The table describes project responsibilities. Actual repository permissions remain controlled
through GitHub repository settings.

`dev` is the only integration line. The former `dev2-go` carry duty is retired;
see [The retired `dev2-go` line](#the-retired-dev2-go-line).

## Former maintainers

| GitHub account | Project role | Period |
| --- | --- | --- |
| [@Wibias](https://github.com/Wibias) | Maintainer | 2026-07-27 – 2026-08-19 |

Former maintainers keep contributor standing and are welcome to open issues and pull requests like
anyone else. Authorship credit in git history, release notes, and code comments is not rewritten
when a maintainer steps down.

## Review and merge policy

- Pull requests target `dev`, the only development and integration line. The
  target-branch check accepts `dev` alone.
- The **`enforce-target`** CI check rejects pull requests whose base is not
  **`dev`** (stacked children excepted), and rejects empty, thin, or malformed
  descriptions; PRs that change files under `gui/`
  must include a screenshot of the UI change in the description. Drag the image
  into the description instead of committing it to the PR branch; command-line
  uploads use the `pr-assets` branch and a commit-SHA link.
  Contributor PRs (authors without repository push permission) open in draft
  and stay there until a four-box review-readiness checklist in the
  description is complete: required local validation passed with its scope documented,
  branch on the latest `dev` commit,
  all correct Codex and CodeRabbit findings fixed, and the ready-for-review
  confirmation. When all four boxes are ticked the gate marks the PR ready and
  notifies the maintainers listed in `MAINTAINERS.md` (excluding the author).
  Completion is bound to the exact commit the PR head pointed at: if new
  commits are pushed afterwards, the gate moves the PR back to draft, resets
  the checklist and the notification, and asks the author to test and tick the
  boxes again against the latest code.
  Before a completion is accepted, the gate verifies the checklist claims
  it can check itself: the branch must be on the latest `dev` commit or at
  most 10 commits behind it, and Codex/CodeRabbit findings must be resolved.
  The local-validation box follows the full-suite default and documented resource
  exception in [AGENTS.md](./AGENTS.md#commands); focused regression tests remain
  mandatory under that exception. It is an author attestation only — fork
  contributors cannot start repository CI; a maintainer has to — so the gate
  never disproves it;
  a new push still resets every box. A disproved claim unticks the matching
  box and keeps the PR a draft.
  As with the approval requirement above, the wrong-base rule is enforced by CI
  rather than by the ruleset.
- Pull requests require successful required CI checks before merge. Contributor pull requests
  normally require approval from at least one maintainer other than the author.
- **Batched merges.** A pull request's own CI is the fast lane by default: `gates` plus
  `test changed` (the tests Bun's import graph reaches from the diff), not the four full
  Ubuntu shards. The shards still run on a pull request that carries the `ci:full` label at
  push time or touches the CI/test harness, fixtures, toolchain or dependency set
  (`scripts/ci/select-test-lane.sh`). Add `ci:full` before pushing when a change reaches shared
  contracts in ways an import graph cannot see (subprocesses, files read as data, generated
  output). Merge green pull requests one at a time; after roughly every five merges, run
  `gh workflow run ci.yml --ref dev` (the default `lane=all`). If that run is red, stop merging,
  fix `dev` from the batch it covers, and resume once it is green. A complete successful
  dispatch is also the cross-platform evidence for the exact commit it tests.
- A current maintainer with GitHub `maintain` or `admin` access may explicitly integrate a pull
  request into `dev` without another maintainer's approval, including their own pull request.
  Record that choice and the exact-head verification in the pull-request description or comment.
  This is maintainer integration, not a self-approval or an independent review. Outstanding
  maintainer change requests must still be resolved or explicitly withdrawn. Technical review,
  attribution, documentation and security-review duties remain in force.
- The maintainer-integration exception applies only to `dev`. It does not grant contributor
  authors approval authority or permit direct pushes, force-pushes or branch deletion. Authors do
  not submit approving reviews of their own work.
- Authentication, credential handling, GitHub Actions, release automation, dependency installation,
  and other security-boundary changes require explicit security review.
- A new or promoted provider preset is a credential-destination change. Before merge it needs the
  primary-source evidence listed under [Adding a provider to the
  catalog](https://opencodex.me/contributing/#evidence-required-for-a-canonical-preset): documented
  OpenAI-compatible endpoints (including authenticated `GET /v1/models` when the entry declares
  `liveModels`), terms of service and operating legal entity, resale or routing authorization for
  aggregators, a named maintenance owner, and a citable verification date. Contributor affiliation
  with the service is disclosed, not disqualifying, and it does not lower the evidence bar. When the
  evidence is incomplete, prefer an inert `src/providers/free-directory.ts` reference row over a
  canonical registry entry.
- Security-sensitive and release-related changes should be reviewed by both maintainers when
  practical.
- Integration uses pull requests, including urgent maintainer repairs. The PR-only ruleset
  bypass does not authorize direct pushes; incident changes to branch protection require a
  separate owner decision.
- npm releases are maintainer-controlled. Preview and stable releases use an eligible
  `dev` commit with successful full manual cross-platform CI; the workflow stamps the
  release version into build checkouts instead of committing a pre-release version bump
  or promoting a branch. Releases share one concurrency group and preserve the global
  version ordering. The `main` and `preview` branches were deleted after the
  single-branch model was in place; released history remains reachable through
  tags, and neither branch is a release target.
- Publication remains disabled until the coordinator completes the cutover checks,
  including the reviewed legacy lineage baseline, npm trusted-publisher configuration,
  default branch and rulesets, Pages settings, and a hosted dry-run. The variable
  `OCX_DEV_RELEASE_PUBLISH_ENABLED` must equal `true` for a real publication; missing
  or other values keep the hold in place. A hosted release dry-run uses the trusted
  `dev` workflow and does not publish.

## The retired `dev2-go` line

`dev2-go` was a parallel integration line that rebuilt the runtime as a Go
native port, and policy required every merge into `dev` to be rebased onto it
and ported under `go/`. That policy is withdrawn as of 2026-07-30.

The dual-track cost outran its return: the carry backlog never cleared (17
commits and 9 open `needs-go-port` issues at the time of the decision, against
594 commits of divergence), and dogfooding the Go runtime kept producing new
defects. Bun-native TypeScript on `dev` is the single runtime line again.

- The branch has been deleted from this repository. Its full history is
  published at
  [lidge-jun/opencodex-go-archive](https://github.com/lidge-jun/opencodex-go-archive),
  and its final tip stays reachable here as the `archive/dev2-go` tag.
- A merge into `dev` carries no port obligation. The nine open `needs-go-port`
  issues (#661, #663, #666, #670, #674, #678, #680, #685, #703) were closed as
  not planned, and the `needs-go-port` label no longer exists on the
  repository.
- Future native work is expected to be an incremental module landing on `dev`
  (Rust via N-API is the current candidate), not a second integration branch.
  Reopening a parallel runtime line is an owner decision.

## Maintainer changes

Adding or removing a maintainer requires:

1. agreement from the project owner,
2. review by another current maintainer when available, and
3. updates to this file and [`.github/CODEOWNERS`](./.github/CODEOWNERS).

### Change log

- 2026-09-06 — The owner authorized explicit maintainer integration into `dev` without a second
  maintainer approval. Both current maintainers have `admin` access. The dev-only PR bypass
  includes GitHub's `admin` and `maintain` roles; `write` access alone is insufficient. Contributor
  review remained the default; the former `main`/`preview` branches were later retired. The optional
  `scripts/ci/assert-mergeable-review.sh --maintainer-integration <pr-number> [repo]` path checks
  the authenticated actor against the trusted `dev` roster and live repository permissions,
  preserves outstanding maintainer objections, and binds its result to the current head and base.
  The helper emits a validation snapshot, not a ready-to-run privileged merge command: head
  matching does not pin a PR's base, which may change after inspection. Revalidate the current
  actor and `dev` base before a separately authorized merge. The helper is not proof of CI or
  security review and not a barrier against an administrator bypassing it. Repository settings
  remain authoritative for actual permissions.

- 2026-08-19 — [@Wibias](https://github.com/Wibias) stepped down as a maintainer
  and is now a contributor. This follows his own decision to stop developing
  opencodex; it is not a disciplinary action, and it was made with the owner's
  agreement (requirement 1). Requirement 2 does not apply to a maintainer's own
  resignation, which needs no second maintainer to ratify it. Requirement 3 is
  met by this file and `.github/CODEOWNERS`, where the default-reviewer line
  and the four runtime paths that listed him (`/src/adapters/`,
  `/src/providers/`, `/src/codex/`, `/src/server/`) drop back to the two
  remaining maintainers. Repository permission was reduced to read access at
  the same time, so the roster and the GitHub settings agree again.

  Nothing he authored is being unwound. His commits, the pull requests he
  merged, the release-note attributions, and the code comments citing his
  reviews stay exactly as they are, and the trust-lane gate derived from his
  work in `.github/scripts/pr-sponsored-surface.cjs` keeps its attribution.
  Returning to the maintainer table later would go through the same three
  requirements that govern every addition.

- 2026-07-27 — [@Wibias](https://github.com/Wibias) added as a maintainer.
  Requirement 1 (agreement from the project owner) is met: the owner requested
  the addition. **Requirement 2 (review by another current maintainer) was
  never satisfied in the form this document describes.** The three commits that
  carried the addition (`a2693c02`, `dc3a4ade`, `02bbd47a`) landed on `dev` as
  direct owner pushes with no associated pull request, so no second maintainer
  reviewed them. Requirement 3 is met by this file and `.github/CODEOWNERS`.
  The addition took effect regardless: @Wibias held write access on the
  repository and merged pull requests from 2026-07-26 until he stepped down on
  2026-08-19. This entry records the gap rather than papering over it — a later
  maintainer change should go through a reviewed pull request.

  Scope covers issue and pull-request triage, `dev` integration, and
  provider/CI maintenance. (This entry originally also described carrying
  merged `dev` work onto `dev2-go`; that duty ended when the line was retired
  on 2026-07-30.) Security-boundary ownership in `.github/CODEOWNERS` is
  deliberately unchanged: authentication, credential handling, GitHub Actions,
  and release automation keep the two owners already listed for those paths, so
  this addition does not widen the review surface for them.

  Code-owner approval and the maintainer-approval requirement above are both
  enforced, not conventions. `dev` carries an active repository ruleset; the
  classic `/branches/{branch}/protection` endpoint can return 404 for rulesets,
  which is why this file long described the repository as unprotected.
  `Protect dev` (id 20763889) requires a pull request with one
  approving review, code-owner review, and extra approval for unattributed
  changes, and it blocks deletion and non-fast-forward pushes. Allowed merge
  methods are merge and squash; rebase merges are off.

  At that time, the actual PR bypass covered `admin`; the earlier wording that
  included `maintain` was inaccurate. The 2026-09-06 policy above adds the explicit
  maintainer-integration exception for `dev` and the corresponding `maintain` role.
  Both roles bypass through pull requests only. Force-push and deletion protections
  remain in place, and the integrating maintainer records the decision and evidence.

## Security reports

Private vulnerability reports are handled by the current maintainers according to
[`SECURITY.md`](./SECURITY.md). Do not disclose secrets or exploit details in a public issue.

## Fork release source and external review

For `alexalok/opencodex`, dispatch the trusted `dev` revision of `release.yml`
with an explicit `release-branch`, exact `expected-sha`, and `version`. This
supersedes dispatching the workflow itself from a release branch. The source
must be the exact current tip of `releases/vX.Y.Z` and a merged PR commit on
that branch. The authorized fork release accounts are owner `alexalok` and owner-authorized
`jack-o-mania`: both the original dispatch actor and rerun actor must be one of
these accounts, and the source PR must have been merged by one of them. Writers, self-approved PRs, upstream roster
membership and repository admin roles do not substitute for this authorization.
The guard reads full PR merger metadata from GitHub under trusted `dev` policy;
candidate-controlled rosters never grant authority. Qualification evidence also
requires authorized dispatch/rerun identities. Candidate execution and publication
jobs independently gate reruns before accessing signing credentials, including
dry runs. Runtime source never comes from current `dev`. Version mirrors
remain committed on the release branch and each backport increases its patch;
the workflow must not derive a newer upstream base or silently change that version.

Select the highest published stable upstream base available for at least 168
hours, using the later GitHub/npm publication time. The guard verifies the
selected base's age, upstream-tag ancestry, and stable patch line. The operator
must record highest-eligible-base selection and individually justified backports.
The fork publishes GitHub releases and verified standalone/desktop assets only.
It never publishes npm packages or changes npm dist-tags. Fork ordering considers
only release-source ancestors; duplicate GitHub tags remain forbidden. npm is
read only to establish the upstream base publication date, never to constrain
the fork version against upstream `latest`.

Fork qualification runs only on disposable GitHub-hosted runners; do not route
release-source code to persistent self-hosted machines. Repository administrators
must enforce runner access outside mutable workflow files as well.

Backport the reviewed CI tooling when necessary and run manual `ci.yml` with
`lane=all` from the exact merged release source. Evidence must match reviewed
policy fingerprints. Service evidence is manually dispatched from trusted `dev`
with the same source SHA and `release-branch`. Repository variable
`OCX_DISABLE_MACOS_CI=true` disables macOS on every event, including manual
qualification and release packaging. Linux and Windows evidence remains mandatory;
disabled macOS is not claimed as validated. Such releases contain only Linux and
Windows assets and updater entries, with the same checksum and signature gates.
When the flag is unset or false, manual qualification requires all three platforms.
Preserve this override when synchronizing upstream workflows.

Security review is performed externally through Codex Security Cloud. Record
review reference and reviewed SHA before merge, resolve applicable findings, and
do not substitute local tests or agent review. Publication hold remains unchanged.
Fork resume is refused until a separately reviewed GitHub receipt/provenance policy
is available. A partial tag or draft publication requires operator recovery; do
not delete or overwrite it automatically. The shared workflow skips all npm jobs
for this fork and publishes only after verifying the asset bundle.
