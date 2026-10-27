import { readCodexAccountRecord } from "../codex/account-store";
import { createResetCreditWhamClient, listCodexAuthAccountsSnapshot } from "../codex/auth-api";
import { isMainAccountIdentityGenerationLive } from "../codex/main-account-cache";
import { fetchAnthropicHubAccountQuota, type ProviderAccountQuota } from "../providers/quota";
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
  quota?: { weeklyPercent?: number; weeklyResetAt?: number; fiveHourPercent?: number } | null;
  resetCreditExpirations?: string[] | null;
}
export interface HubQuotaReaders {
  openai(config: OcxConfig, signal?: AbortSignal): Promise<HubQuotaAccount[]>;
  anthropic(config: OcxConfig, signal?: AbortSignal): Promise<HubQuotaAccount[]>;
}

/** Existing quota reads may refresh cached metadata/credentials, never select or pause accounts. */
export const hubQuotaReaders: HubQuotaReaders = {
  async openai(config, signal) {
    signal?.throwIfAborted();
    if ((config.codexAccounts?.length ?? 0) >= MAX_HUB_QUOTA_ACCOUNTS) throw new Error("Quota unavailable");
    const snapshot = await listCodexAuthAccountsSnapshot(config);
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
    if (!isMainAccountIdentityGenerationLive(snapshot.mainIdentityGeneration)) throw new Error("Quota unavailable");
    if (rows.some(row => !row.isMain && generations.get(row.id) !== readCodexAccountRecord(row.id)?.generation)) {
      throw new Error("Quota unavailable");
    }
    return rows.filter(row => row.isMain || config.codexAccounts?.some(account => account.id === row.id));
  },
  async anthropic(config, signal) {
    signal?.throwIfAborted();
    const provider = config.providers.anthropic;
    const accounts = getAccountSet("anthropic")?.accounts ?? [];
    if (accounts.length > MAX_HUB_QUOTA_ACCOUNTS) throw new Error("Quota unavailable");
    const rows: ProviderAccountQuota[] = [];
    for (let offset = 0; offset < accounts.length; offset += 8) {
      signal?.throwIfAborted();
      rows.push(...await Promise.all(accounts.slice(offset, offset + 8).map(account => fetchAnthropicHubAccountQuota(account.id))));
    }
    signal?.throwIfAborted();
    const current = getAccountSet("anthropic")?.accounts ?? [];
    if (config.providers.anthropic !== provider || rows.some(row => row.unavailable || row.isCurrent?.() === false)) {
      throw new Error("Quota unavailable");
    }
    return current.map(account => ({
      id: account.id, alias: account.alias,
      quota: rows.find(row => row.accountId === account.id)?.quota ?? null,
    }));
  },
};
