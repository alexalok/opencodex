import { afterEach, beforeEach, expect, jest, test } from "bun:test";
import { clearProviderQuotaCache, clearProviderQuotaCacheFor, fetchProviderQuotaReports } from "../../src/providers/quota";
import { bindTrafficQuotaConfig, refreshQuotaAfterRequest } from "../../src/providers/quota/traffic-refresh";
import { getProviderQuotaReportCache } from "../../src/providers/quota/report-cache";
import { setLiveStateStoreConfig } from "../../src/lib/state-store-registrations";
import { runPassiveRead } from "../../src/lib/passive-read";
import { ensureQuotaPoolIdentity } from "../../src/quota-pool/identity";
import { readQuotaTray } from "../../src/quota-pool/tray";
import { addFinalRequestLog } from "../../src/server/request-log";
import { resetOptionalShutdownHooksForTests } from "../../src/lib/optional-shutdown-hooks";
import type { OcxConfig } from "../../src/types";

const originalFetch = globalThis.fetch;
let config: OcxConfig;
let calls: number;
let percent: number;
const response = (used = percent) => Response.json({ success: true, data: { limits: [
  { type: "TOKENS_LIMIT", unit: 3, number: 5, percentage: used },
  { type: "TOKENS_LIMIT", unit: 6, number: 1, percentage: used / 2 },
] } });
const held = () => runPassiveRead(() => fetchProviderQuotaReports(config));
const settle = () => Bun.sleep(350);
// Real network parsing finishes in microtasks; fake timers own the probe deadlines.
const flushProbe = async () => { for (let i = 0; i < 30; i++) await Promise.resolve(); };
function complete(provider = "zai") {
  addFinalRequestLog("quota-traffic-test", Date.now(), { provider, model: "glm-5" }, 200,
    { terminalStatus: "completed" }, () => {});
}

beforeEach(() => {
  calls = 0; percent = 0;
  config = { defaultProvider: "zai", providers: {
    zai: { adapter: "openai-chat", authMode: "key", baseUrl: "https://api.z.ai/api/coding/paas/v4", apiKey: "test-zai-quota-key" },
  } } as OcxConfig;
  resetOptionalShutdownHooksForTests();
  clearProviderQuotaCache();
  setLiveStateStoreConfig(config);
  globalThis.fetch = (async () => { calls++; return response(); }) as typeof fetch;
});
afterEach(() => {
  bindTrafficQuotaConfig(null);
  clearProviderQuotaCache();
  globalThis.fetch = originalFetch;
});

test("completed Z.ai request refreshes held quota without a dashboard poll", async () => {
  await fetchProviderQuotaReports(config);
  const cacheTime = getProviderQuotaReportCache()!.ts;
  expect((await held()).reports[0]!.quota.fiveHourPercent).toBe(0);
  percent = 2;
  complete();
  await settle();
  const reports = (await held()).reports;
  expect(calls).toBe(2);
  expect(reports[0]!.quota.fiveHourPercent).toBe(2);
  expect(reports[0]!.quota.weeklyPercent).toBe(1);
  expect(getProviderQuotaReportCache()!.ts).toBe(cacheTime);
  ensureQuotaPoolIdentity();
  const tray = await runPassiveRead(() => readQuotaTray(config));
  expect(tray.ok && tray.tray.providers.find(row => row.provider === "zai")).toMatchObject({
    fiveHour: { remainingPercent: 98 }, weekly: { remainingPercent: 99 },
  });
  expect(calls).toBe(2);
});

test("passive reads alone and passive completion calls start nothing", async () => {
  await runPassiveRead(async () => {
    expect((await fetchProviderQuotaReports(config, true)).reports).toEqual([]);
    complete();
  });
  await settle();
  expect(calls).toBe(0);
});

test("bursts debounce, then trailing traffic refreshes once after the minute", async () => {
  jest.useFakeTimers();
  try {
    for (let i = 0; i < 10; i++) complete();
    jest.advanceTimersByTime(300);
    await flushProbe();
    expect(calls).toBe(1);
    percent = 12;
    for (let i = 0; i < 10; i++) complete();
    jest.advanceTimersByTime(59_000);
    expect(calls).toBe(1);
    jest.advanceTimersByTime(1_000);
    await flushProbe();
    expect(calls).toBe(2);
    expect((await held()).reports[0]!.quota.fiveHourPercent).toBe(12);
  } finally { jest.useRealTimers(); }
});

test("only providers that served traffic are probed, including fallback attempts", async () => {
  config.providers.deepseek = { adapter: "openai-chat", baseUrl: "https://api.deepseek.com", apiKey: "test-other-key" };
  globalThis.fetch = (async (url: string | URL | Request) => {
    expect(String(url)).toContain("api.z.ai/api/monitor/"); calls++; return response(4);
  }) as typeof fetch;
  refreshQuotaAfterRequest({ provider: "combo", attempts: [
    { provider: "deepseek", sendCount: 0 }, { provider: "deepseek", sendCount: 1, locallyAnswered: true }, { provider: "zai", sendCount: 1 },
  ] });
  await settle();
  expect(calls).toBe(1);
  expect((await held()).reports.map(row => row.provider)).toEqual(["zai"]);
});

for (const mutation of ["credential", "destination", "disabled", "clear", "provider-clear", "rebind"] as const) {
  test(`in-flight traffic probe cannot publish after ${mutation} changes`, async () => {
    let release!: (response: Response) => void;
    globalThis.fetch = (() => { calls++; return new Promise<Response>(resolve => { release = resolve; }); }) as typeof fetch;
    complete(); await settle(); expect(calls).toBe(1);
    if (mutation === "credential") config.providers.zai!.apiKey = "test-replacement-key";
    if (mutation === "destination") config.providers.zai!.baseUrl = "https://example.test/v1";
    if (mutation === "disabled") config.providers.zai!.disabled = true;
    if (mutation === "clear") clearProviderQuotaCache();
    if (mutation === "provider-clear") clearProviderQuotaCacheFor("zai");
    if (mutation === "rebind") bindTrafficQuotaConfig({ ...config });
    release(response(20)); await settle();
    expect((await held()).reports).toEqual([]);
  });
}

test("traffic refresh wins over an older overlapping dashboard probe", async () => {
  let release!: (response: Response) => void;
  globalThis.fetch = (() => {
    calls++;
    if (calls === 1) return new Promise<Response>(resolve => { release = resolve; });
    return Promise.resolve(response(25));
  }) as typeof fetch;
  const dashboard = fetchProviderQuotaReports(config);
  await Bun.sleep(20);
  complete(); await settle();
  expect((await held()).reports[0]!.quota.fiveHourPercent).toBe(25);
  release(response(0)); await dashboard;
  expect((await held()).reports[0]!.quota.fiveHourPercent).toBe(25);
});

test("transient probe failure preserves last-good report and terminal failure removes it", async () => {
  await fetchProviderQuotaReports(config);
  const before = (await held()).reports[0];
  globalThis.fetch = (async () => Response.json({}, { status: 503 })) as typeof fetch;
  complete(); await settle();
  expect((await held()).reports[0]).toBe(before);
  bindTrafficQuotaConfig(null); bindTrafficQuotaConfig(config);
  globalThis.fetch = (async () => Response.json({}, { status: 401 })) as typeof fetch;
  complete(); await settle();
  expect((await held()).reports).toEqual([]);
});
