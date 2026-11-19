# Fork release 2.100.11 on upstream v2.100.2

## Base selection

Selected on 2026-11-19 at 09:16 UTC (12:16 Europe/Moscow). The highest stable
upstream release available for 168 hours was v2.100.2, commit
61147ec681bc8374d350e0eae08b71c117c6df30. GitHub publication was
2026-11-11T03:51:12Z; npm publication was 2026-11-11T03:50:06.113Z. The later
GitHub timestamp controls eligibility. v2.100.3 was published November 14 and
was not eligible. No newer upstream runtime changes are included wholesale.

Sources: https://github.com/lidge-jun/opencodex/releases/tag/v2.100.2 and the
`@bitkyc08/opencodex` npm registry publication timestamps.

Release target: `releases/v2.100.2`. Backport branch:
`backports/v2.100.2/hub-native-discovery`. Four package/desktop version mirrors
are 2.100.11: one patch increment for each of the nine feature groups below.

## Individually justified backports

| Patch | Preserved behavior | Fork source |
| --- | --- | --- |
| 2.100.3 | Discover native Pool models on hubs and project them into catalog downloads without requiring a managed local client | #40, e111ae1f42369ad21c48f4791471f39f61d6da69 |
| 2.100.4 | Validated Hub bearer admission for stored-account search without forwarding the Hub key | #3, f9206d4d85 |
| 2.100.5 | Local management access on IPv4 loopback aliases while preserving data-plane auth | cbc48e31ec |
| 2.100.6 | Native GPT approval reviewers and reviewer reasoning controls | #20, e7fb410a03 |
| 2.100.7 | Quota tray API with pooled recovery and reset-credit expiry | #24, bec93178f3 |
| 2.100.8 | Per-account recovery detail in quota tray responses | #35, 4fb756608a |
| 2.100.9 | Preserve a matching link service token when service environment is stale | #36, 847102055c |
| 2.100.10 | Refresh held key-provider quota after routed traffic | #39, 4a9ef41351 |
| 2.100.11 | Explicit read-only Hub quota grants with ownership checks, private deduplication, and isolated transport failures | 60a506213c, 1f49c43694, 3955a088ad, 8fb10cc25d, 8f57ad56dd |

Fable 5.2 client identity and headless Pool account listing already exist in the
selected upstream base; they are not duplicated. Remembered browser sessions
also supersede the older raw-admin-token persistence patch.

The release retains reviewed fork qualification/publication tooling from fork
head e111ae1f42369ad21c48f4791471f39f61d6da69. Its existing evidence fingerprints
are unchanged. This is required to preserve GitHub-only assets, authorized
actors, exact-source qualification, disposable hosted runners, and the
OCX_DISABLE_MACOS_CI override. The prior native-startup test stabilization from
#30 is retained. These tooling/test adaptations are not extra runtime features.

## Compatibility adaptations

- The release's older child-operations engine stays intact; only catalog revision
  projection and its live-config binding are backported.
- Existing upstream local-control ingress remains trusted when adding IPv4
  loopback aliases.
- The frozen classic dashboard retains its shared reviewer-helper compatibility export.
- The paused-account search fixture asserts this base's fenced native-main 503
  refusal and zero upstream sends. The later upstream Pool-only routing policy
  is not pulled in merely to change that status to 401.
- Reset-credit inspection retains its sanitized available-count DTO for Hub
  quota reads and expiry bookkeeping.

## Integration and publication boundaries

Pinned upstream dev for this integration process:
1b5f65f4398795d232bae1440ce8d7299a928f10. Fork policy requires a separate upstream
sync before merging if fork dev does not contain it. That sync does not change
this release's age-eligible runtime base.

This preparation does not publish, install, restart, or deploy anything. Before
publication, the backport must be reviewed and merged into its release branch,
with external Codex Security Cloud review and successful exact-head PR CI.
Manual Linux/Windows CI and service qualification must then cover the exact
merged release source. macOS stays disabled by the existing repository override.
Dispatch release.yml from trusted dev only after explicit publication approval.
