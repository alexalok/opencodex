# Read-only hub quotas

`src/server/hub-quota.ts` serves exact GET `/v1/hub-quota` on a hub. The listener's
existing route allowlists remain authoritative; this endpoint does not widen a
Remote Link, management, intercept, or unauthenticated-loopback ingress.

Admission requires the configured data key in `X-OpenCodex-API-Key`, its literal
`allowQuotaRead: true` grant, and any ingress key allowlist. Environment and administrator
credentials do not qualify. The grant schema in `src/config/schema/leaf-validators.ts`
defaults to denied and degrades malformed values to false. Existing provider scope
limits visible pools; nonempty model scope is rejected because quotas are account-wide.
Admission, scope, role, and provider enablement are checked again after asynchronous reads.

`src/server/management/oauth-account-routes.ts` adds grant-only PATCH to the existing
key-management route. Rename, provider/model scope, and quota grant are validated before
publishing one replacement entry. Issuance never grants access; rotation preserves it.

`src/server/hub-quota-snapshot.ts` reads only OpenAI and primary Anthropic pools.
OpenAI rows preserve pause state and per-account switch-threshold overrides, including zero.
Main duplicates are removed by email, plan and reset-window agreement before projection.
`src/codex/auth-api/reset-credit-service.ts` retains available count so zero hides historical expiry rows.
Its normal quota and credential reads may refresh caches, plan metadata, or OAuth health;
the endpoint never selects, pauses, removes, or resets accounts, or redeems credits.

`src/providers/quota/hub-anthropic.ts` keeps a separate bounded quota cache rather than
entering the pool's cooldown-recovery workflow. The actual post-refresh bearer and ownership
come from one account snapshot. Cache and publication are fenced by credential generation,
login identity, added time, quota epoch, pause state, and reauthentication state.
Paused, reauthentication-required, and expired background CLI rows report unknown quota;
healthy accounts remain visible, and even unknown rows retain ownership checks.
Underlying usage flights are credential-bound; stale entries cannot cross a same-slot login.

Schema version 1 exposes process-local opaque IDs, bounded aliases, plan, used percentages,
nullable unknown readings and reset-credit expiry dates. It never projects credentials,
email addresses, raw account IDs, destinations, or upstream errors. Responses are no-store;
provider errors are independent. Limits are 128 accounts per provider, 64 expirations per
account, 256 KiB serialized output and a 20-second provider wait. Cancellation stops later
batches while existing upstream reads retain their own deadlines.

Regression coverage lives in `tests/server/hub-quota.test.ts` and
`tests/server/api-keys-routes.test.ts`. Operator instructions are in the public
[remote hub guide](../docs-site/src/content/docs/guides/remote-hub.md).
