import { credentialGeneration, getAccountSet } from "../../oauth/store";
import type { ProviderAccount } from "../../oauth/types";
import type { ProviderQuota } from "../quota-types";
import { ACCOUNT_QUOTA_TTL_MS } from "../quota-wire";
import { captureProviderAccountQuotaEpoch, getTokenForAccountQuotaProbe, normalizeAnthropicQuota, type ProviderAccountQuota } from "./account-cache";
import { fetchAnthropicUsageQuota } from "./vendor-probes-oauth";

// The hub cannot use legacy slot-keyed quota entries: a slot can be re-enrolled.
// Keep its bounded cache tied to the exact post-refresh credential generation.
const hubAnthropicQuotaCache = new Map<string, { generation: string; ts: number; quota: ProviderQuota | null }>();

export async function fetchAnthropicHubAccountQuota(accountId: string): Promise<ProviderAccountQuota> {
  const currentRow = () => getAccountSet("anthropic")?.accounts.find(account => account.id === accountId);
  const identity = (row: ProviderAccount | undefined) => row && !row.paused && !row.needsReauth
    ? JSON.stringify([credentialGeneration(row.credential), row.loginId, row.addedAt, captureProviderAccountQuotaEpoch("anthropic")])
    : undefined;
  // A skipped/failed token read is unknown only while its original owner still exists.
  const before = currentRow();
  const ownership = (row: ProviderAccount | undefined) => row
    ? JSON.stringify([credentialGeneration(row.credential), row.loginId, row.addedAt, captureProviderAccountQuotaEpoch("anthropic")]) : undefined;
  const original = ownership(before);
  let token: string;
  try { token = await getTokenForAccountQuotaProbe("anthropic", accountId); }
  catch {
    const isCurrent = () => original !== undefined && ownership(currentRow()) === original;
    if (!isCurrent()) throw new Error("Quota unavailable");
    const unavailable: ProviderAccountQuota = { accountId, quota: null, unavailable: true };
    Object.defineProperty(unavailable, "isCurrent", { value: isCurrent });
    return unavailable;
  }
  // Bind the exact dispatched bearer and ownership to one store snapshot after renewal.
  const row = currentRow();
  if (!row || row.credential.access !== token) throw new Error("Quota unavailable");
  const generation = identity(row);
  if (!generation) throw new Error("Quota unavailable");
  const isCurrent = () => identity(currentRow()) === generation;
  const cached = hubAnthropicQuotaCache.get(accountId);
  // The underlying usage reader joins only probes using this exact bearer.
  let quota: ProviderQuota | null;
  try {
    quota = cached?.generation === generation && Date.now() - cached.ts < ACCOUNT_QUOTA_TTL_MS
      ? cached.quota : await fetchAnthropicUsageQuota(token);
  } catch {
    // Ordinary transport failures are per-account unknowns, never cached successes.
    if (!isCurrent()) throw new Error("Quota unavailable");
    const unavailable: ProviderAccountQuota = { accountId, quota: null, unavailable: true };
    Object.defineProperty(unavailable, "isCurrent", { value: isCurrent });
    return unavailable;
  }
  if (!isCurrent()) throw new Error("Quota unavailable");
  if (!cached || cached.generation !== generation || Date.now() - cached.ts >= ACCOUNT_QUOTA_TTL_MS) {
    hubAnthropicQuotaCache.delete(accountId);
    if (hubAnthropicQuotaCache.size >= 128) hubAnthropicQuotaCache.delete(hubAnthropicQuotaCache.keys().next().value!);
    hubAnthropicQuotaCache.set(accountId, { generation, ts: Date.now(), quota });
  }
  const result: ProviderAccountQuota = { accountId, quota: normalizeAnthropicQuota(quota, Date.now()), ...(!quota ? { unavailable: true as const } : {}) };
  Object.defineProperty(result, "isCurrent", { value: isCurrent });
  return result;
}
