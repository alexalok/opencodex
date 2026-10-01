# Hidden codex-auto-review row — root cause and decision

Branch `alex/fix-codex-auto-review-catalog`, cut from `7c625fc97`.

## Symptom

With `approvals_reviewer = "auto_review"` and `model_catalog_json` pointing at the OpenCodex
catalog, Codex Guardian reviewed approvals with the current turn's model instead of its default
reviewer. For a routed third-party main model that review can fail and fail closed. Upstream
report: lidge-jun/opencodex#1225 (comment of 2026-08-13, confirmed 2026-08-19); the shipped
mitigation was the root/provider `auto_review_model` selector (#2631), not the missing row.

## Evidence

- A live catalog written by sync had 9 rows (5 natives, 4 routed), no `codex-auto-review`, and
  every `auto_review_model_override` null. The same home's `models_cache.json`, fetched by Codex
  0.159.2, carried `codex-auto-review` with `visibility: "hide"`, `supported_in_api: true`,
  priority 43 and a full `model_messages.auto_review` policy.
- codex-rs `ext/guardian-reviewer/src/model.rs` `select_review_model`: reviewer id is the parent
  row's `auto_review_model_override`, else the provider's preferred id (`codex-auto-review` under
  ChatGPT auth). It is looked up in `models_manager.list_models`; when absent and not overridden,
  `core/src/guardian/reviewer_config.rs` `resolve_review_model` reuses the PARENT model and the
  parent row's `model_messages`. A static catalog has no remote merge or cache fallback, so the
  file OpenCodex writes is the whole universe. `list_models` keeps hidden rows.
- `prompts/src/model_messages.rs` `auto_review()` falls back to bundled defaults when a row has
  no `auto_review` messages, so the pinned snapshot row (which predates that block) is a valid
  fallback reviewer.

## Root cause

`CANONICAL_NATIVE_CATALOG_CONTENT_POLICY` drops bare rows for which
`isUnsupportedOpenAiNativeSlug` is true: not routed, not in `SUPPORTED_NATIVE_OPENAI_SLUGS`, and
matching `^(?:gpt|codex)-`. The legacy/internal native hygiene of 2026-06-29 (`b5c484839`,
`13c03e604`) swept `codex-auto-review` in through the `codex-` prefix. Nothing in history, devlogs
or upstream issues gives a functional reason to drop it: it is a hidden control-plane helper, not a
legacy picker model. `src/router.ts` already routes it to the canonical OpenAI provider.

## Decision

- Exact allowlist `CODEX_CONTROL_PLANE_HELPER_MODELS = {"codex-auto-review"}` in
  `native-models.ts`. Not added to `NATIVE_OPENAI_MODELS`, `SUPPORTED_NATIVE_OPENAI_SLUGS` or
  `UPSTREAM_NATIVE_ENTRIES` (the sync-replacement authority invariant is unchanged); the `codex-`
  prefix rule is not widened; disjoint from `RETIRED_NATIVE_OPENAI_MODELS`.
- Both writers (retained sync, convergence) project one hidden row after the picker pipeline, from
  the first genuine row in: Codex models cache, installed/source catalog, the file being
  overwritten, backups; else the pinned snapshot. No mock ladder, multi-agent stamp, featured
  priority or display overlay is applied; WebSocket flags and strict parser fields are normalized
  like every row. Gated on `includeNativeOpenAi` like the bare natives.
- Root auto-review stamping skips the helper row. Guardian reads the override from the parent
  row; a stamp on the reviewer row would describe nothing. Provider stamps only ever touch routed
  rows. A selector naming `codex-auto-review` now resolves instead of being reported unresolved.
- Account-selector projection is untouched: the observation prefix is `gpt-|o1-|o3-|o4-`, so no
  per-selector clone exists and entitlement filtering never sees the helper.

## Verification

Recorded in the branch commit and its report: focused file
`tests/codex-integration/codex-auto-review-helper-row.test.ts` (pure merge cases plus both real
writers from a models cache and from the pin), flipped pins in
`codex-catalog-sync-hardening.test.ts` and `codex-catalog.test.ts`, and a mutation pass proving
each wiring point is load-bearing.
