/**
 * `GET /api/quota-pool/tray`: the compact `ocx.quota-tray/1` read the OpenCodexTray menu-bar app
 * renders verbatim. It carries every number the tray shows, so the tray computes none itself.
 *
 * Built from the same collection as `ocx.quota-pool/1` (`collectQuotaPoolProviders`), inside
 * `runPassiveRead`. Per provider it keeps the pooled 5-hour and weekly windows as remaining
 * percent, the next capacity recovery of each (`pooledRecovery`), and the pool-wide block from the
 * `availability` window with the window that holds it. Per account: display name, plan, the
 * plan's capacity weight (`units`), its own 5-hour and weekly windows, and its reset credits.
 *
 * Reset-credit expiry is not in WHAM usage. The read answers from the in-memory memo
 * (`src/codex/reset-credit-expiry-memo.ts`) and, after responding, may start a background
 * inspect for an account whose memo is missing or no longer matches its credit count: one account
 * at a time, at most once per `RESET_CREDIT_INSPECT_RETRY_MS` per account. The response itself
 * never waits on upstream.
 */
import type { OcxConfig } from "../types";
import { runPassiveRead } from "../lib/passive-read";
import { peekResetCreditExpiry, noteResetCreditInspect } from "../codex/reset-credit-expiry-memo";
import { OPENAI_CODEX_PROVIDER_ID } from "../providers/openai-tiers-destination";
import type { CodexCapacityWindowAggregation } from "../providers/codex-capacity";
import type { QuotaPoolAccountState, QuotaPoolWindow } from "./contract";
import { collectQuotaPoolProviders, type CollectedQuotaProvider, type QuotaPoolDeps, type TrackedAccount } from "./assemble";
import { readQuotaPoolIdentity } from "./identity";
import { pooledRecovery } from "./pooled";

export const QUOTA_TRAY_SCHEMA = "ocx.quota-tray/1" as const;
export const RESET_CREDIT_INSPECT_RETRY_MS = 60 * 60_000;

/** Times are epoch milliseconds. */
export interface QuotaTrayWindow {
  remainingPercent: number;
  resetsAt?: number;
  exhausted?: boolean;
}

export interface QuotaTrayPoolWindow extends QuotaTrayWindow {
  /** Earliest moment some of this window's used capacity comes back. */
  nextRecoveryAt?: number;
  /** Share of the pool's capacity that comes back then. */
  nextRecoveryPercent?: number;
}

export interface QuotaTrayAccount {
  name: string;
  plan?: string;
  /** Capacity weight of the plan: Plus = 1. */
  units: number;
  state: QuotaPoolAccountState;
  fiveHour?: QuotaTrayWindow;
  weekly?: QuotaTrayWindow;
  resetCredits?: { count: number; soonestExpiresAt?: number };
}

export interface QuotaTrayProvider {
  provider: string;
  fiveHour?: QuotaTrayPoolWindow;
  weekly?: QuotaTrayPoolWindow;
  /** Present while no eligible account can run; `window` is what holds the first recovery. */
  blocked?: { window: "5h" | "weekly" | "other"; recoversAt?: number };
  /** Reset credits available across the provider's accounts. */
  resetCredits: number;
  accounts: QuotaTrayAccount[];
}

export interface QuotaTray {
  schema: typeof QUOTA_TRAY_SCHEMA;
  generatedAt: number;
  providers: QuotaTrayProvider[];
}

export interface QuotaTrayDeps extends QuotaPoolDeps {
  /** Background reset-credit inspect; defaults to the WHAM client. Throws on failure. */
  inspectResetCredits?: (config: OcxConfig, accountId: string) => Promise<{ credits: { granted_at: string; expires_at: string }[]; available_count?: number }>;
}

export type QuotaTrayResult = { ok: true; tray: QuotaTray } | { ok: false; error: "quota_pool_identity_unavailable" };

const timeMs = (value: string | undefined): number | undefined => {
  if (value === undefined) return undefined;
  const ms = Date.parse(value);
  return Number.isFinite(ms) ? ms : undefined;
};

function trayWindow(window: QuotaPoolWindow | undefined): QuotaTrayWindow | undefined {
  if (!window || window.usedPercent === undefined) return undefined;
  const resetsAt = timeMs(window.resetsAt);
  return {
    remainingPercent: Math.max(0, 100 - window.usedPercent),
    ...(resetsAt !== undefined ? { resetsAt } : {}),
    ...(window.exhausted === true ? { exhausted: true } : {}),
  };
}

const TRAY_WINDOW_IDS = { fiveHour: "5h", weekly: "weekly" } as const;
const REPORT_AGGREGATION_KEYS = { fiveHour: "fiveHour", weekly: "weekly" } as const;

function poolWindow(collected: CollectedQuotaProvider, key: keyof typeof TRAY_WINDOW_IDS, now: number): QuotaTrayPoolWindow | undefined {
  const id = TRAY_WINDOW_IDS[key];
  const base = trayWindow(collected.windows.find(window => window.id === id && window.scopeModel === undefined));
  if (!base) return undefined;
  let recovery: { at: number; percent: number } | undefined;
  if (collected.poolFromRows) {
    recovery = pooledRecovery(collected.rows.map(row => row.pool), id, now);
  } else {
    const aggregation = collected.report?.aggregation as { [k: string]: CodexCapacityWindowAggregation | undefined } | undefined;
    const reported = aggregation?.[REPORT_AGGREGATION_KEYS[key]];
    if (reported?.nextRecoveryAt !== undefined && reported.nextRecoveryAt > now && reported.nextRecoveryPercent !== undefined) {
      recovery = { at: reported.nextRecoveryAt, percent: reported.nextRecoveryPercent };
    } else if (base.resetsAt !== undefined && base.remainingPercent < 100) {
      // One report stands for one budget: all of its used share comes back at its reset.
      recovery = { at: base.resetsAt, percent: 100 - base.remainingPercent };
    }
  }
  return recovery ? { ...base, nextRecoveryAt: recovery.at, nextRecoveryPercent: recovery.percent } : base;
}

function blockingId(id: string): "5h" | "weekly" | "other" {
  return id === "5h" || id === "weekly" ? id : "other";
}

function blocked(collected: CollectedQuotaProvider): QuotaTrayProvider["blocked"] {
  if (collected.poolFromRows) {
    const availability = collected.windows.find(window => window.id === "availability");
    if (!availability) return undefined;
    const recoversAt = timeMs(availability.resetsAt);
    // The window whose reset is the pool's first recovery.
    const holder = recoversAt === undefined ? undefined : collected.rows
      .flatMap(row => row.pool.windows)
      .find(window => window.exhausted === true && window.scopeModel === undefined && timeMs(window.resetsAt) === recoversAt);
    return { window: holder ? blockingId(holder.id) : "other", ...(recoversAt !== undefined ? { recoversAt } : {}) };
  }
  // A report is one budget: it runs again once its last exhausted window resets.
  const exhausted = collected.windows.filter(window => window.exhausted === true && window.scopeModel === undefined);
  if (exhausted.length === 0) return undefined;
  let holder = exhausted[0]!;
  for (const window of exhausted) {
    if ((timeMs(window.resetsAt) ?? Number.POSITIVE_INFINITY) > (timeMs(holder.resetsAt) ?? Number.POSITIVE_INFINITY)) holder = window;
  }
  const recoversAt = timeMs(holder.resetsAt);
  return { window: blockingId(holder.id), ...(recoversAt !== undefined ? { recoversAt } : {}) };
}

function accountName(row: TrackedAccount): string {
  return row.meta.alias ?? row.meta.email ?? row.account.label ?? row.account.provider;
}

function trayAccount(row: TrackedAccount, now: number, stale: string[]): QuotaTrayAccount {
  const windows = row.account.windows.filter(window => window.scopeModel === undefined);
  const fiveHour = trayWindow(windows.find(window => window.id === "5h"));
  const weekly = trayWindow(windows.find(window => window.id === "weekly"));
  const count = row.meta.resetCredits;
  let resetCredits: QuotaTrayAccount["resetCredits"];
  if (count !== undefined && count > 0) {
    const memo = peekResetCreditExpiry(row.meta.accountId, count, now);
    if (!memo.fresh && row.account.provider === OPENAI_CODEX_PROVIDER_ID) stale.push(row.meta.accountId);
    resetCredits = { count, ...(memo.soonestExpiresAt !== undefined ? { soonestExpiresAt: memo.soonestExpiresAt } : {}) };
  }
  return {
    name: accountName(row),
    ...(row.account.plan !== undefined ? { plan: row.account.plan } : {}),
    units: row.pool.weight,
    state: row.account.state,
    ...(fiveHour ? { fiveHour } : {}),
    ...(weekly ? { weekly } : {}),
    ...(resetCredits ? { resetCredits } : {}),
  };
}

function trayProvider(collected: CollectedQuotaProvider, now: number, stale: string[]): QuotaTrayProvider | null {
  const fiveHour = poolWindow(collected, "fiveHour", now);
  const weekly = poolWindow(collected, "weekly", now);
  const block = blocked(collected);
  if (!fiveHour && !weekly && !block && collected.rows.length === 0) return null;
  const accounts = collected.rows.map(row => trayAccount(row, now, stale));
  return {
    provider: collected.name,
    ...(fiveHour ? { fiveHour } : {}),
    ...(weekly ? { weekly } : {}),
    ...(block ? { blocked: block } : {}),
    resetCredits: accounts.reduce((sum, account) => sum + (account.resetCredits?.count ?? 0), 0),
    accounts,
  };
}

const lastInspectAttempt = new Map<string, number>();
let inspecting = false;

async function defaultInspect(config: OcxConfig, accountId: string) {
  const { createResetCreditWhamClient } = await import("../codex/auth-api/reset-credit-service");
  return createResetCreditWhamClient(config, accountId).inspect();
}

/** Inspect stale accounts one at a time, each at most once per retry window. Never throws. */
async function refreshResetCreditExpiries(config: OcxConfig, accountIds: readonly string[], deps: QuotaTrayDeps): Promise<void> {
  if (inspecting) return;
  const now = (deps.now ?? Date.now)();
  const due = accountIds.filter(id => now - (lastInspectAttempt.get(id) ?? Number.NEGATIVE_INFINITY) >= RESET_CREDIT_INSPECT_RETRY_MS);
  if (due.length === 0) return;
  inspecting = true;
  try {
    for (const id of due) {
      lastInspectAttempt.set(id, (deps.now ?? Date.now)());
      try {
        noteResetCreditInspect(id, await (deps.inspectResetCredits ?? defaultInspect)(config, id), (deps.now ?? Date.now)());
      } catch {
        // Count-only until the next retry window.
      }
    }
  } finally {
    inspecting = false;
  }
}

/** The tray view, or an identity error. The response never waits on upstream. */
export async function readQuotaTray(config: OcxConfig, deps: QuotaTrayDeps = {}): Promise<QuotaTrayResult & { refresh?: Promise<void> }> {
  const stale: string[] = [];
  const result = await runPassiveRead(async (): Promise<QuotaTrayResult> => {
    const identity = readQuotaPoolIdentity();
    if (!identity) return { ok: false, error: "quota_pool_identity_unavailable" };
    const now = (deps.now ?? Date.now)();
    const providers = (await collectQuotaPoolProviders(config, identity, now, deps))
      .flatMap(collected => trayProvider(collected, now, stale) ?? []);
    return { ok: true, tray: { schema: QUOTA_TRAY_SCHEMA, generatedAt: now, providers } };
  });
  if (!result.ok || stale.length === 0) return result;
  return { ...result, refresh: refreshResetCreditExpiries(config, stale, deps) };
}

export function resetQuotaTrayStateForTests(): void {
  lastInspectAttempt.clear();
  inspecting = false;
}
