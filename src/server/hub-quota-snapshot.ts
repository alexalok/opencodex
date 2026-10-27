import { readCodexAccountRecord } from "../codex/account-store";
import { createResetCreditWhamClient, listCodexAuthAccountsSnapshot } from "../codex/auth-api";
import { isMainAccountIdentityGenerationLive } from "../codex/main-account-cache";
import { fetchAnthropicHubAccountQuota } from "../providers/quota/hub-anthropic";
import type { ProviderAccountQuota } from "../providers/quota/account-cache";
import { getAccountSet } from "../oauth/store";
import type { OcxConfig } from "../types";

export const MAX_HUB_QUOTA_ACCOUNTS = 128;
export interface HubQuotaAccount {
  id: string;
  alias?: string;
  email?: string;
  plan?: string | null;
  isMain?: boolean;
  paused?: boolean;
  autoSwitchThresholdOverride?: number | null;
  quota?: { weeklyPercent?: number; weeklyResetAt?: number; fiveHourPercent?: number } | null;
  resetCreditExpirations?: string[] | null;
}
export type HubQuotaSnapshot = HubQuotaAccount[] & { readonly isCurrent?: () => boolean };
function ownedSnapshot(rows: HubQuotaAccount[], isCurrent: () => boolean): HubQuotaSnapshot {
  if (!isCurrent()) throw new Error("Quota unavailable");
  Object.defineProperty(rows, "isCurrent", { value: isCurrent });
  return rows;
}
export interface HubQuotaReaders {
  openai(config: OcxConfig, signal?: AbortSignal): Promise<HubQuotaSnapshot>;
  anthropic(config: OcxConfig, signal?: AbortSignal): Promise<HubQuotaSnapshot>;
}

/** Existing quota reads may refresh cached metadata/credentials, never select or pause accounts. */
export const hubQuotaReaders: HubQuotaReaders = {
  async openai(config, signal) {
    signal?.throwIfAborted();
    if ((config.codexAccounts?.length ?? 0) >= MAX_HUB_QUOTA_ACCOUNTS) throw new Error("Quota unavailable");
    const snapshot = await listCodexAuthAccountsSnapshot(config);
    const roster = JSON.stringify(config.codexAccounts?.map(account => account.id) ?? []);
    const generations = new Map(snapshot.accounts.filter(account => !account.isMain).map(account => [account.id, readCodexAccountRecord(account.id)?.generation]));
    // Bound upstream concurrency; expiration failure preserves independently available quota.
    const rows: HubQuotaAccount[] = [];
    for (let offset = 0; offset < snapshot.accounts.length; offset += 8) {
      signal?.throwIfAborted();
      const batch = await Promise.all(snapshot.accounts.slice(offset, offset + 8).map(async account => {
        let resetCreditExpirations: string[] | null = null;
        if (account.hasCredential) {
          try {
            const result = await createResetCreditWhamClient(config, account.id).inspect();
            resetCreditExpirations = result.available_count === 0 ? [] : result.credits.map(credit => credit.expires_at);
          } catch { /* Unknown remains null. Never expose upstream errors. */ }
        }
        return { ...account, resetCreditExpirations };
      }));
      rows.push(...batch);
    }
    signal?.throwIfAborted();
    const isCurrent = () => isMainAccountIdentityGenerationLive(snapshot.mainIdentityGeneration)
      && roster === JSON.stringify(config.codexAccounts?.map(account => account.id) ?? [])
      && rows.every(row => row.isMain || (config.codexAccounts?.some(account => account.id === row.id)
        && generations.get(row.id) === readCodexAccountRecord(row.id)?.generation));
    return ownedSnapshot(rows, isCurrent);
  },
  async anthropic(config, signal) {
    signal?.throwIfAborted();
    const provider = config.providers.anthropic;
    const accounts = getAccountSet("anthropic")?.accounts ?? [];
    if (accounts.length > MAX_HUB_QUOTA_ACCOUNTS) throw new Error("Quota unavailable");
    const roster = JSON.stringify(accounts.map(account => account.id));
    const rows: ProviderAccountQuota[] = [];
    for (let offset = 0; offset < accounts.length; offset += 8) {
      signal?.throwIfAborted();
      rows.push(...await Promise.all(accounts.slice(offset, offset + 8).map(account => fetchAnthropicHubAccountQuota(account.id))));
    }
    signal?.throwIfAborted();
    const current = getAccountSet("anthropic")?.accounts ?? [];
    const isCurrent = () => config.providers.anthropic === provider
      && roster === JSON.stringify(getAccountSet("anthropic")?.accounts.map(account => account.id) ?? [])
      && rows.every(row => row.isCurrent?.() !== false);
    return ownedSnapshot(current.map(account => ({
      id: account.id, alias: account.alias,
      quota: rows.find(row => row.accountId === account.id)?.quota ?? null,
    })), isCurrent);
  },
};
