/**
 * Producer side of `ocx.quota-tray/1` (`GET /api/quota-pool/tray`), the read the OpenCodexTray app
 * renders verbatim: remaining percent per pooled window, next recovery from the same weighted
 * estimate the dashboard uses, the pool-wide block with the window that holds it, and per-account
 * plan units and reset credits with a memoized, rate-limited expiry lookup.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { OcxConfig } from "../../src/types";
import type { StoredAccountQuota } from "../../src/codex/quota-types";
import { codexQuotaWindows } from "../../src/quota-pool/assemble";
import { pooledBlockHolder, pooledRecovery, pooledWindows, type PooledAccountInput } from "../../src/quota-pool/pooled";
import type { QuotaPoolWindow } from "../../src/quota-pool/contract";
import { providerResetCredits, readQuotaTray, resetQuotaTrayStateForTests, RESET_CREDIT_INSPECT_RETRY_MS } from "../../src/quota-pool/tray";
import type { TrackedAccount } from "../../src/quota-pool/assemble";
import { RESET_CREDIT_EXPIRY_MEMO_TTL_MS } from "../../src/codex/reset-credit-expiry-memo";
import { aggregateCodexPoolCapacity, codexCapacityWeight } from "../../src/providers/codex-capacity";
import { ensureQuotaPoolIdentity, resetQuotaPoolIdentityMemoForTests } from "../../src/quota-pool/identity";
import { saveCodexAccountCredential } from "../../src/codex/account-store";
import { clearAccountQuota, setAccountQuotaFromParsed } from "../../src/codex/quota";
import { noteResetCreditInspect, peekResetCreditExpiry, resetResetCreditExpiryMemoForTests } from "../../src/codex/reset-credit-expiry-memo";
import {
  captureMainAccountIdentityGeneration, clearMainAccountInfoCache, observeMainQuotaIdentity, setMainAccountInfoCache,
  type CachedMainAccountInfo,
} from "../../src/codex/main-account-cache";
import { MAIN_CODEX_ACCOUNT_ID } from "../../src/codex/account-id";
import { getAccountSet, saveCredential } from "../../src/oauth/store";
import { clearAccountQuotaCache, setCachedProviderAccountQuotaForTests } from "../../src/providers/quota";
import { setProviderQuotaReportCache } from "../../src/providers/quota/report-cache";
import { linkManagementReadAllowed } from "../../src/link/management-routes";
import { runPassiveRead } from "../../src/lib/passive-read";
import { installIsolatedCodexHome, type IsolatedCodexHome } from "../helpers/isolated-codex-home";
import { removeTreeWithRetry } from "../helpers/remove-tree";

const NOW = Date.parse("2026-10-21T12:00:00.000Z");
const HOUR = 3_600_000;
const MINUTE = 60_000;
let home = "";
let priorHome: string | undefined;
let admissionPath = "";
let codexHome: IsolatedCodexHome | null = null;

beforeEach(() => {
  priorHome = process.env.OPENCODEX_HOME;
  home = mkdtempSync(join(tmpdir(), "ocx-quota-tray-"));
  process.env.OPENCODEX_HOME = home;
  resetQuotaPoolIdentityMemoForTests();
  resetResetCreditExpiryMemoForTests();
  resetQuotaTrayStateForTests();
  ensureQuotaPoolIdentity();
});

afterEach(async () => {
  setProviderQuotaReportCache(null);
  clearAccountQuotaCache("xai");
  clearAccountQuota();
  await Bun.sleep(300); // let the clear's debounced persist land before the home is removed
  codexHome?.restore();
  codexHome = null;
  resetQuotaPoolIdentityMemoForTests();
  if (priorHome === undefined) delete process.env.OPENCODEX_HOME;
  else process.env.OPENCODEX_HOME = priorHome;
  removeTreeWithRetry(home);
});

describe("pooled recovery", () => {
  const codex = (plan: string, quota: Omit<StoredAccountQuota, "updatedAt">, eligible = true): PooledAccountInput => ({
    eligible,
    weight: codexCapacityWeight(plan),
    windows: codexQuotaWindows({ ...quota, updatedAt: NOW - MINUTE } as StoredAccountQuota, "measured", NOW),
  });

  test("matches the dashboard's capacity aggregate for mixed plans", () => {
    const quotas = [
      { plan: "plus", weeklyPercent: 80, weeklyResetAt: NOW + 24 * HOUR },
      { plan: "prolite", weeklyPercent: 30, weeklyResetAt: NOW + 48 * HOUR },
      { plan: "pro", weeklyPercent: 50, weeklyResetAt: NOW + 24 * HOUR },
    ];
    const recovery = pooledRecovery(quotas.map(({ plan, ...quota }) => codex(plan, quota)), "weekly", NOW);
    const capacity = aggregateCodexPoolCapacity(quotas.map(({ plan, ...quota }) => ({
      isMain: false, plan, paused: false, quota: { ...quota, updatedAt: NOW - MINUTE },
    })), NOW);
    expect(recovery).toEqual({ at: NOW + 24 * HOUR, percent: (0.8 + 20 * 0.5) / 31 * 100 });
    expect(recovery!.at).toBe(capacity.aggregation!.weekly!.nextRecoveryAt!);
    expect(recovery!.percent).toBeCloseTo(capacity.aggregation!.weekly!.nextRecoveryPercent!, 10);
  });

  test("ineligible accounts and unused capacity never recover anything", () => {
    expect(pooledRecovery([codex("pro", { weeklyPercent: 0, weeklyResetAt: NOW + HOUR })], "weekly", NOW)).toBeUndefined();
    expect(pooledRecovery([codex("pro", { weeklyPercent: 60, weeklyResetAt: NOW + HOUR }, false)], "weekly", NOW)).toBeUndefined();
  });
});

describe("ocx.quota-tray/1", () => {
  test("the tray path is a link-relayable read without a refresh form", () => {
    expect(linkManagementReadAllowed("GET", "/api/quota-pool/tray")).toBe(true);
    expect(linkManagementReadAllowed("GET", "/api/quota-pool/tray", "refresh=1")).toBe(false);
  });

  test("remaining percent, recovery and the pool block from held caches", async () => {
    for (const slot of ["a", "b"]) {
      await saveCredential("xai", {
        access: `synthetic-access-${slot}`, refresh: `synthetic-refresh-${slot}`, expires: Date.now() + HOUR,
        accountId: `xai-raw-account-${slot}`, email: `xai-${slot}@example.test`,
      } as never);
    }
    const [first] = getAccountSet("xai")!.accounts.map(row => row.id);
    setCachedProviderAccountQuotaForTests("xai", first!, { weeklyPercent: 42, weeklyResetAt: NOW + 48 * HOUR, updatedAt: NOW - MINUTE });
    admissionPath = join(home, "claude-usage-admission.json");
    writeFileSync(admissionPath, JSON.stringify({
      identity: "c".repeat(64), checkedAt: NOW - 30_000,
      quota: { fiveHourPercent: 100, fiveHourResetAt: NOW + HOUR, weeklyPercent: 61, weeklyResetAt: NOW + 72 * HOUR, updatedAt: NOW - 30_000 },
    }));
    setProviderQuotaReportCache({ key: "fixture", ts: NOW, response: { generatedAt: NOW, reports: [{
      provider: "zai", label: "Z.ai", source: "fixture", updatedAt: NOW - 120_000,
      quota: { fiveHourPercent: 30, fiveHourResetAt: NOW + 2 * HOUR, weeklyPercent: 80, weeklyResetAt: NOW + 96 * HOUR, updatedAt: NOW - 120_000 },
    }] } });
    const config = {
      port: 0, defaultProvider: "zai",
      providers: {
        xai: { adapter: "openai-chat", baseUrl: "https://api.x.ai/v1", authMode: "oauth" },
        "claude-cli": { adapter: "claude-cli", baseUrl: "http://127.0.0.1:9" },
        zai: { adapter: "openai-chat", baseUrl: "https://api.z.ai/v1", apiKey: "fixture-zai-key" },
      },
    } as OcxConfig;
    const result = await readQuotaTray(config, { now: () => NOW, claudeUsageStatePath: admissionPath });
    if (!result.ok) throw new Error(result.error);
    expect(result.refresh).toBeUndefined();
    expect(result.tray).toEqual({
      schema: "ocx.quota-tray/1",
      generatedAt: NOW,
      providers: [
        {
          provider: "claude-cli",
          fiveHour: { remainingPercent: 0, resetsAt: NOW + HOUR, exhausted: true, nextRecoveryAt: NOW + HOUR, nextRecoveryPercent: 100 },
          weekly: { remainingPercent: 39, resetsAt: NOW + 72 * HOUR, nextRecoveryAt: NOW + 72 * HOUR, nextRecoveryPercent: 61 },
          blocked: { window: "5h", recoversAt: NOW + HOUR },
          resetCredits: 0,
          accounts: [{
            name: "claude-cli", units: 1, state: "exhausted",
            fiveHour: { remainingPercent: 0, resetsAt: NOW + HOUR, exhausted: true },
            weekly: { remainingPercent: 39, resetsAt: NOW + 72 * HOUR },
          }],
        },
        {
          provider: "xai",
          // The account without a reading is unknown there, so it neither counts nor recovers.
          weekly: { remainingPercent: 58, resetsAt: NOW + 48 * HOUR, nextRecoveryAt: NOW + 48 * HOUR, nextRecoveryPercent: 42 },
          resetCredits: 0,
          // OAuth emails follow privacy.maskEmails, which masks unless it is literally false.
          accounts: [
            { name: "x***a@example.test", units: 1, state: "available", weekly: { remainingPercent: 58, resetsAt: NOW + 48 * HOUR } },
            { name: "x***b@example.test", units: 1, state: "unknown" },
          ],
        },
        {
          provider: "zai",
          fiveHour: { remainingPercent: 70, resetsAt: NOW + 2 * HOUR, nextRecoveryAt: NOW + 2 * HOUR, nextRecoveryPercent: 30 },
          weekly: { remainingPercent: 20, resetsAt: NOW + 96 * HOUR, nextRecoveryAt: NOW + 96 * HOUR, nextRecoveryPercent: 80 },
          resetCredits: 0,
          accounts: [],
        },
      ],
    });

    const unmasked = await readQuotaTray({ ...config, privacy: { maskEmails: false } } as OcxConfig, { now: () => NOW, claudeUsageStatePath: admissionPath });
    if (!unmasked.ok) throw new Error(unmasked.error);
    expect(unmasked.tray.providers.find(provider => provider.provider === "xai")!.accounts.map(account => account.name))
      .toEqual(["xai-a@example.test", "xai-b@example.test"]);
  });

  test("Codex rows carry plan units and reset credits; the expiry is inspected once, after the answer", async () => {
    codexHome = installIsolatedCodexHome("ocx-quota-tray-codex-");
    const config = {
      port: 0, defaultProvider: "openai",
      providers: { openai: { adapter: "openai-responses", baseUrl: "https://chatgpt.com/backend-api/codex", authMode: "forward" } },
      codexAccounts: [{ id: "tray-prolite", email: "tray-prolite@example.test", alias: "Work Pro", plan: "prolite", isMain: false }],
    } as OcxConfig;
    const { saveConfig } = await import("../../src/config");
    saveConfig(config);
    saveCodexAccountCredential("tray-prolite", {
      accessToken: "access-tray", refreshToken: "refresh-tray", expiresAt: Date.now() + HOUR, chatgptAccountId: "acct-tray",
    });
    const now = Date.now();
    const sec = (ms: number) => Math.floor(ms / 1000);
    setAccountQuotaFromParsed("tray-prolite", {
      weeklyPercent: 100, weeklyResetAt: sec(now + 50 * HOUR), resetCredits: 2,
    });
    const inspected: string[] = [];
    let failInspect = false;
    let clock = now;
    const deps = {
      now: () => clock,
      inspectResetCredits: async (_config: OcxConfig, accountId: string) => {
        inspected.push(accountId);
        if (failInspect) throw new Error("fixture upstream");
        return { available_count: 2, credits: [
          { granted_at: new Date(now - HOUR).toISOString(), expires_at: new Date(now + 70 * HOUR).toISOString() },
          { granted_at: new Date(now - HOUR).toISOString(), expires_at: new Date(now + 30 * HOUR).toISOString() },
        ] };
      },
    };
    // A Remote Link Child's relayed read is already passive: it must not make the Home inspect.
    const relayed = await runPassiveRead(() => readQuotaTray(config, deps));
    expect(relayed.refresh).toBeUndefined();
    expect(inspected).toEqual([]);

    const first = await readQuotaTray(config, deps);
    if (!first.ok) throw new Error(first.error);
    const openai = first.tray.providers.find(provider => provider.provider === "openai")!;
    const row = openai.accounts.find(account => account.name === "Work Pro")!;
    expect(row).toMatchObject({ plan: "prolite", units: 10, state: "exhausted", resetCredits: { count: 2 } });
    expect(row.fiveHour).toBeUndefined();
    expect(row.resetCredits!.soonestExpiresAt).toBeUndefined();
    expect(openai.resetCredits).toBe(2);
    expect(openai.weekly).toMatchObject({ remainingPercent: 0, nextRecoveryAt: sec(now + 50 * HOUR) * 1000, nextRecoveryPercent: 100 });
    // The signed-out Codex App login has no evidence, so routing would still try it: not blocked.
    expect(openai.blocked).toBeUndefined();
    await first.refresh;
    expect(inspected).toEqual(["tray-prolite"]);

    const second = await readQuotaTray(config, deps);
    if (!second.ok) throw new Error(second.error);
    expect(second.refresh).toBeUndefined();
    const memo = second.tray.providers.find(provider => provider.provider === "openai")!.accounts.find(account => account.name === "Work Pro")!;
    expect(memo.resetCredits).toEqual({ count: 2, soonestExpiresAt: Date.parse(new Date(now + 30 * HOUR).toISOString()) });

    // An aged memo is inspected again; a failed inspect is retried only after the retry window.
    const refreshAt = async (at: number) => {
      clock = at;
      await (await readQuotaTray(config, deps) as { refresh?: Promise<void> }).refresh;
    };
    failInspect = true;
    await refreshAt(now + RESET_CREDIT_EXPIRY_MEMO_TTL_MS);
    expect(inspected).toEqual(["tray-prolite", "tray-prolite"]);
    await refreshAt(now + RESET_CREDIT_EXPIRY_MEMO_TTL_MS + MINUTE);
    expect(inspected).toHaveLength(2);
    await refreshAt(now + RESET_CREDIT_EXPIRY_MEMO_TTL_MS + RESET_CREDIT_INSPECT_RETRY_MS);
    expect(inspected).toHaveLength(3);
  });

  test("the main inspect retry window belongs to the signed-in identity", async () => {
    codexHome = installIsolatedCodexHome("ocx-quota-tray-main-");
    const config = {
      port: 0, defaultProvider: "openai",
      providers: { openai: { adapter: "openai-responses", baseUrl: "https://chatgpt.com/backend-api/codex", authMode: "forward" } },
    } as OcxConfig;
    const now = Date.now();
    const signIn = (identity: string) => {
      observeMainQuotaIdentity(identity);
      setMainAccountInfoCache({
        email: `${identity}@example.test`, plan: "plus", ts: now,
        quota: { weeklyPercent: 100, weeklyResetAt: Math.floor((now + 50 * HOUR) / 1000), resetCredits: 1 },
      } as CachedMainAccountInfo);
    };
    const inspected: string[] = [];
    let clock = now;
    const deps = {
      now: () => clock,
      inspectResetCredits: async (_config: OcxConfig, accountId: string) => {
        inspected.push(accountId);
        throw new Error("fixture upstream");
      },
    };
    const read = async () => {
      await (await readQuotaTray(config, deps) as { refresh?: Promise<void> }).refresh;
    };
    try {
      signIn("tray-cooldown-a");
      await read();
      expect(inspected).toEqual([MAIN_CODEX_ACCOUNT_ID]);
      clock = now + MINUTE;
      await read();
      expect(inspected).toHaveLength(1);

      // A different login inherits nothing from the previous identity's failed attempt.
      signIn("tray-cooldown-b");
      clock = now + 2 * MINUTE;
      await read();
      expect(inspected).toEqual([MAIN_CODEX_ACCOUNT_ID, MAIN_CODEX_ACCOUNT_ID]);
    } finally {
      clearMainAccountInfoCache();
    }
  });
});

describe("reset-credit expiry memo", () => {
  const credits = (expiresAt: number) => ({ available_count: 1, credits: [{ expires_at: new Date(expiresAt).toISOString() }] });

  test("the native main memo is bound to the physical identity it was inspected for", () => {
    observeMainQuotaIdentity("tray-memo-physical-a");
    const generationA = captureMainAccountIdentityGeneration();
    noteResetCreditInspect(MAIN_CODEX_ACCOUNT_ID, credits(NOW + 30 * HOUR), NOW, generationA);
    expect(peekResetCreditExpiry(MAIN_CODEX_ACCOUNT_ID, 1, NOW)).toEqual({ fresh: true, soonestExpiresAt: NOW + 30 * HOUR });

    // Account B signs in with the same credit count: A's expiry must not be shown for it.
    observeMainQuotaIdentity("tray-memo-physical-b");
    expect(peekResetCreditExpiry(MAIN_CODEX_ACCOUNT_ID, 1, NOW)).toEqual({ fresh: false });

    // An inspect that ran under A but finished after the switch is not recorded for B.
    noteResetCreditInspect(MAIN_CODEX_ACCOUNT_ID, credits(NOW + 40 * HOUR), NOW, generationA);
    expect(peekResetCreditExpiry(MAIN_CODEX_ACCOUNT_ID, 1, NOW)).toEqual({ fresh: false });
    noteResetCreditInspect(MAIN_CODEX_ACCOUNT_ID, credits(NOW + 50 * HOUR), NOW);
    expect(peekResetCreditExpiry(MAIN_CODEX_ACCOUNT_ID, 1, NOW)).toEqual({ fresh: false });

    noteResetCreditInspect(MAIN_CODEX_ACCOUNT_ID, credits(NOW + 50 * HOUR), NOW, captureMainAccountIdentityGeneration());
    expect(peekResetCreditExpiry(MAIN_CODEX_ACCOUNT_ID, 1, NOW)).toEqual({ fresh: true, soonestExpiresAt: NOW + 50 * HOUR });

    // A superseded inspect that lands late is dropped without clearing B's live memo.
    noteResetCreditInspect(MAIN_CODEX_ACCOUNT_ID, credits(NOW + 40 * HOUR), NOW, generationA);
    expect(peekResetCreditExpiry(MAIN_CODEX_ACCOUNT_ID, 1, NOW)).toEqual({ fresh: true, soonestExpiresAt: NOW + 50 * HOUR });
  });

  test("pool accounts are keyed by their own id and need no identity generation", () => {
    noteResetCreditInspect("tray-memo-pool", credits(NOW + 30 * HOUR), NOW);
    observeMainQuotaIdentity("tray-memo-physical-c");
    expect(peekResetCreditExpiry("tray-memo-pool", 1, NOW)).toEqual({ fresh: true, soonestExpiresAt: NOW + 30 * HOUR });
  });
});

describe("pooled block holder", () => {
  const spent = (id: "5h" | "weekly", resetsAt: number): QuotaPoolWindow => ({
    id, kind: id === "5h" ? "burst_5h" : "weekly", label: id, usedPercent: 100, exhausted: true,
    resetsAt: new Date(resetsAt).toISOString(), source: "measured", observedAt: new Date(NOW - MINUTE).toISOString(),
  });
  const account = (eligible: boolean, ...windows: QuotaPoolWindow[]): PooledAccountInput => ({ eligible, weight: 1, windows });
  const recovery = (accounts: PooledAccountInput[]) =>
    pooledWindows(accounts, NOW).find(window => window.id === "availability")?.resetsAt;

  test("an excluded account's window never names the block", () => {
    const accounts = [account(false, spent("5h", NOW + HOUR)), account(true, spent("weekly", NOW + HOUR))];
    expect(recovery(accounts)).toBe(new Date(NOW + HOUR).toISOString());
    expect(pooledBlockHolder(accounts, NOW)).toBe("weekly");
  });

  test("an account still blocked by a later window does not hold the first recovery", () => {
    const accounts = [
      account(true, spent("5h", NOW + HOUR), spent("weekly", NOW + 48 * HOUR)),
      account(true, spent("weekly", NOW + HOUR)),
    ];
    expect(recovery(accounts)).toBe(new Date(NOW + HOUR).toISOString());
    expect(pooledBlockHolder(accounts, NOW)).toBe("weekly");
  });

  test("an account that can run means there is no block to hold", () => {
    expect(pooledBlockHolder([account(true, spent("5h", NOW + HOUR)), account(true)], NOW)).toBeUndefined();
  });
});

describe("provider reset credits", () => {
  const row = (accountId: string, resetCredits: number, duplicateMain?: true): TrackedAccount => ({
    account: { provider: "openai", accountRef: accountId, state: "available", windows: [] },
    pool: { eligible: !duplicateMain, weight: 1, windows: [] },
    meta: { accountId, resetCredits, ...(duplicateMain ? { duplicateMain } : {}) },
  });

  test("a pool row duplicating the main login does not count its credits twice", () => {
    expect(providerResetCredits([row("__main__", 2), row("stored-main-copy", 2, true), row("other", 1)])).toBe(3);
  });
});
