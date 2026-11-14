import { isPassiveRead } from "../../lib/passive-read";
import { captureConfigGeneration } from "../../lib/state-store-sweeper";
import { didRunOptionalShutdownHooks, registerOptionalShutdownHook } from "../../lib/optional-shutdown-hooks";
import type { OcxConfig } from "../../types";
import { resolveProviderApiKey } from "../key-store";
import { replaceCachedProviderQuotas } from "../quota-routing-cache";
import { mayCommitProviderQuotaKey } from "./account-cache";
import { keyQuotaReaderForProvider } from "./vendor-probes-key";
import {
  advanceProviderReportEpoch, AUTHORITATIVE_EMPTY_QUOTA, bindKeyReportCredential,
  captureProviderReportEpochs, getProviderQuotaReportCache, isProviderQuotaReportCurrent,
  invalidationEpoch, keyReportCredentialCurrent, LAST_GOOD_MAX_AGE_MS,
  providerReportEpochChanged, publishCollectedDecisionQuota, routingEvidence,
  setProviderQuotaReportCache, TERMINAL_QUOTA_FAILURE,
} from "./report-cache";

const INTERVAL_MS = 60_000;
const SETTLE_MS = 250;
type Pending = { lastStart: number; timer?: ReturnType<typeof setTimeout>; running?: Promise<void>; dirty: boolean };
const pending = new Map<string, Pending>();
let liveConfig: OcxConfig | null = null;

/** Bind only the running server's config; management reads never activate probes. */
export function bindTrafficQuotaConfig(config: OcxConfig | null): void {
  if (config === liveConfig) return;
  for (const state of pending.values()) if (state.timer) clearTimeout(state.timer);
  pending.clear();
  liveConfig = config;
  if (config) registerOptionalShutdownHook("traffic-quota", () => bindTrafficQuotaConfig(null));
}

/** The shared final-request seam includes completed streams, retries and native ingress. */
export function refreshQuotaAfterRequest(request: {
  provider: string;
  attempts?: ReadonlyArray<{ provider: string; sendCount: number; locallyAnswered?: boolean }>;
}): void {
  if (isPassiveRead() || !liveConfig || didRunOptionalShutdownHooks()) return;
  const names = request.attempts?.length
    ? request.attempts.filter(attempt => attempt.sendCount > 0 && !attempt.locallyAnswered).map(attempt => attempt.provider)
    : [request.provider];
  for (const name of new Set(names)) {
    const provider = liveConfig.providers[name];
    if (!provider || !keyQuotaReaderForProvider(name, provider)) continue;
    let state = pending.get(name);
    if (!state) { state = { lastStart: -Infinity, dirty: false }; pending.set(name, state); }
    state.dirty = true;
    schedule(name, state);
  }
}

function schedule(name: string, state: Pending): void {
  if (state.timer || state.running || !state.dirty || !liveConfig) return;
  state.timer = setTimeout(() => {
    state.timer = undefined;
    state.dirty = false;
    state.lastStart = Date.now();
    state.running = probe(name).catch(() => { /* quota must never fail a request */ }).finally(() => {
      state.running = undefined;
      if (pending.get(name) === state) schedule(name, state);
    });
  }, Math.max(SETTLE_MS, state.lastStart + INTERVAL_MS - Date.now()));
  state.timer.unref();
}

async function probe(name: string): Promise<void> {
  const config = liveConfig;
  const provider = config?.providers[name];
  if (!config || !provider || isPassiveRead() || didRunOptionalShutdownHooks()) return;
  const reader = keyQuotaReaderForProvider(name, provider);
  if (!reader) return;
  const credential = resolveProviderApiKey(provider.apiKey)?.trim();
  // Traffic refresh never refreshes OAuth or resolves another account's token.
  if (!credential) return;
  const snapshot = { ...provider };
  const epoch = invalidationEpoch, epochs = captureProviderReportEpochs(), generation = captureConfigGeneration();
  const result = await reader(name, snapshot);
  const current = config.providers[name];
  if (config !== liveConfig || epoch !== invalidationEpoch || providerReportEpochChanged(epochs, name)
    || !mayCommitProviderQuotaKey(name, generation) || !current || !keyQuotaReaderForProvider(name, current)
    || current.adapter !== snapshot.adapter || current.baseUrl !== snapshot.baseUrl
    || resolveProviderApiKey(current.apiKey)?.trim() !== credential) return;
  if (result === null) return; // A transient failure retains the original last-good timestamp.
  const cache = getProviderQuotaReportCache();
  const reports = (cache?.response.reports ?? []).filter(row => row.provider !== name
    && config.providers[row.provider] && !config.providers[row.provider]!.disabled
    && isProviderQuotaReportCurrent(row) && keyReportCredentialCurrent(row, config.providers[row.provider])
    && (row.observed === true || Date.now() - row.updatedAt < LAST_GOOD_MAX_AGE_MS));
  if (result !== TERMINAL_QUOTA_FAILURE && result !== AUTHORITATIVE_EMPTY_QUOTA) {
    bindKeyReportCredential(result, snapshot, credential);
    if (!keyReportCredentialCurrent(result, current)) return;
    reports.push(result);
  }
  advanceProviderReportEpoch(name);
  // Do not extend the aggregate TTL or claim that unrelated providers were probed.
  setProviderQuotaReportCache({ key: cache?.key ?? "", ts: cache?.ts ?? 0, response: { generatedAt: Date.now(), reports } });
  replaceCachedProviderQuotas(reports, routingEvidence);
  publishCollectedDecisionQuota(reports, config);
}
