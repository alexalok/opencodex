import { expect, test } from "bun:test";
import { handleHubQuota } from "../../src/server/hub-quota";
import type { OcxConfig } from "../../src/types";

const key = "quota-test-credential";
function config(): OcxConfig { return { runtimeRole: "hub", port: 0, defaultProvider: "openai", providers: {
  openai: { adapter: "openai-responses", baseUrl: "https://example.test" },
  anthropic: { adapter: "anthropic", baseUrl: "https://example.test" },
}, apiKeys: [{ id: "client", name: "client", key, createdAt: "", allowQuotaRead: true }] }; }
const request = () => new Request("http://localhost/v1/hub-quota", { headers: { "x-opencodex-api-key": key } });
const rows = [{ id: "raw-secret-id", alias: "Work", email: "person@example.test", plan: "plus", isMain: false, paused: true, quota: { weeklyPercent: 23, weeklyResetAt: 100 }, resetCreditExpirations: ["2027-01-01T00:00:00Z"] },
  { id: "__main__", email: "person@example.test", plan: "plus", isMain: true, paused: false, quota: { weeklyPercent: 24, weeklyResetAt: 102 } }];
const readers = { openai: async () => rows, anthropic: async () => [{ id: "raw-anthropic", email: "person@example.test", quota: { fiveHourPercent: 8, weeklyPercent: 19 } }] };

test("projects only safe quota fields and removes duplicate main within reset tolerance", async () => {
  const res = await handleHubQuota(request(), config(), readers);
  const body = await res.json();
  expect(body.providers.openai.accounts).toHaveLength(1);
  expect(body.providers.openai.accounts[0]).toMatchObject({ alias: "Work", plan: "plus", isMain: false, paused: true, weeklyPercent: 23, autoSwitchThreshold: 80, resetCreditExpirations: ["2027-01-01T00:00:00.000Z"] });
  expect(body.providers.anthropic.accounts[0]).toMatchObject({ fiveHourPercent: 8, weeklyPercent: 19 });
  expect(JSON.stringify(body)).not.toMatch(/raw-secret-id|raw-anthropic|person@|example\.test/);
  const second = await (await handleHubQuota(request(), config(), readers)).json();
  expect(second.providers.openai.accounts[0].id).toBe(body.providers.openai.accounts[0].id);
});

test("honors provider restriction and rejects malformed or model scopes", async () => {
  const c = config(); c.apiKeys![0]!.allowedProviders = ["anthropic"];
  const body = await (await handleHubQuota(request(), c, readers)).json();
  expect(body.providers.openai).toEqual({ enabled: false, accounts: [] });
  expect(body.providers.anthropic.accounts).toHaveLength(1);
  c.apiKeys![0]!.allowedModels = ["claude-model"];
  expect((await handleHubQuota(request(), c, readers)).status).toBe(403);
  c.apiKeys![0]!.allowedModels = [];
  c.apiKeys![0]!.allowedProviders = "anthropic" as unknown as string[];
  expect((await handleHubQuota(request(), c, readers)).status).toBe(403);
});

test("revoked grant, rotated secret, changed role or narrowed scope cannot publish in-flight data", async () => {
  for (const mutate of [
    (c: OcxConfig) => { c.apiKeys![0]!.allowQuotaRead = false; },
    (c: OcxConfig) => { c.apiKeys![0]!.key = "rotated-secret"; },
    (c: OcxConfig) => { c.runtimeRole = "standalone"; },
    (c: OcxConfig) => { c.apiKeys![0]!.allowedProviders = ["anthropic"]; },
  ]) {
    const c = config();
    const res = await handleHubQuota(request(), c, { ...readers, openai: async () => { mutate(c); return rows; } });
    expect([401,403,404]).toContain(res.status);
    expect(await res.text()).not.toContain("Work");
  }
});

test("provider failure is partial and safe, all failed reads unavailable, account count bounded", async () => {
  const fail = async () => { throw new Error("provider-token@example.test"); };
  const partial = await (await handleHubQuota(request(), config(), { ...readers, anthropic: fail })).json();
  expect(partial.providers.openai.accounts).toHaveLength(1);
  expect(partial.providers.anthropic).toEqual({ enabled: true, accounts: [], error: "Quota unavailable" });
  expect((await handleHubQuota(request(), config(), { openai: fail, anthropic: fail })).status).toBe(503);
  const bounded = await (await handleHubQuota(request(), config(), { ...readers, openai: async () => Array(129).fill(rows[0]) })).json();
  expect(bounded.providers.openai.accounts).toEqual([]);
  expect(bounded.providers.openai.error).toBe("Quota unavailable");
});

test("unknown quota remains null, bad numbers and unsafe labels never escape", async () => {
  const body = await (await handleHubQuota(request(), config(), { ...readers, openai: async () => [{ id: "fixture", alias: "person@example.test", plan: "https://private.test", quota: { weeklyPercent: NaN } }] })).json();
  expect(body.providers.openai.accounts[0]).toMatchObject({ weeklyPercent: null, resetCreditExpirations: null });
  expect(body.providers.openai.accounts[0].alias).toBeUndefined();
  expect(body.providers.openai.accounts[0].plan).toBeUndefined();
});

test("strict boolean grant and non-hub role fail closed", async () => {
  const c = config();
  for (const value of [undefined, false, "true", 1]) {
    c.apiKeys![0]!.allowQuotaRead = value as boolean;
    expect((await handleHubQuota(request(), c, readers)).status).toBe(403);
  }
  c.runtimeRole = "standalone";
  expect((await handleHubQuota(request(), c, readers)).status).toBe(404);
});

test("duplicate-main filtering requires email, plan and matching reset window", async () => {
  for (const main of [
    { ...rows[1], email: "different@example.test" },
    { ...rows[1], plan: "pro" },
    { ...rows[1], quota: { weeklyResetAt: 103 } },
    { ...rows[1], quota: null },
  ]) {
    const body = await (await handleHubQuota(request(), config(), { ...readers, openai: async () => [rows[0]!, main as typeof rows[0]] })).json();
    expect(body.providers.openai.accounts).toHaveLength(2);
  }
});

test("snapshot does not attach old pool quota after credential replacement during expiry read", async () => {
  const { spyOn } = await import("bun:test");
  const api = await import("../../src/codex/auth-api");
  const store = await import("../../src/codex/account-store");
  const { hubQuotaReaders } = await import("../../src/server/hub-quota-snapshot");
  const { captureMainAccountIdentityGeneration } = await import("../../src/codex/main-account-cache");
  let generation = 1;
  const snapshot = spyOn(api, "listCodexAuthAccountsSnapshot").mockResolvedValue({ accounts: [{ ...rows[0], hasCredential: true }], mainIdentityGeneration: captureMainAccountIdentityGeneration() } as never);
  const record = spyOn(store, "readCodexAccountRecord").mockImplementation(() => ({ generation }) as never);
  const credits = spyOn(api, "createResetCreditWhamClient").mockReturnValue({ inspect: async () => { generation = 2; return { credits: [] }; }, consume: async () => { throw new Error("must never consume"); } });
  const c = config(); c.codexAccounts = [{ id: "raw-secret-id", email: "person@example.test" }];
  try { await expect(hubQuotaReaders.openai(c)).rejects.toThrow("Quota unavailable"); }
  finally { snapshot.mockRestore(); record.mockRestore(); credits.mockRestore(); }
});

test("zero available reset credits hides historical expiration entries", async () => {
  const { spyOn } = await import("bun:test");
  const api = await import("../../src/codex/auth-api");
  const { hubQuotaReaders } = await import("../../src/server/hub-quota-snapshot");
  const { captureMainAccountIdentityGeneration } = await import("../../src/codex/main-account-cache");
  const snapshot = spyOn(api, "listCodexAuthAccountsSnapshot").mockResolvedValue({ accounts: [{ ...rows[0], hasCredential: true }], mainIdentityGeneration: captureMainAccountIdentityGeneration() } as never);
  const credits = spyOn(api, "createResetCreditWhamClient").mockReturnValue({ inspect: async () => ({ available_count: 0, credits: [{ granted_at: "2026-01-01T00:00:00Z", expires_at: "2027-01-01T00:00:00Z" }] }), consume: async () => { throw new Error("must never consume"); } });
  const c = config(); c.codexAccounts = [{ id: "raw-secret-id", email: "person@example.test" }];
  try { expect((await hubQuotaReaders.openai(c))[0]!.resetCreditExpirations).toEqual([]); }
  finally { snapshot.mockRestore(); credits.mockRestore(); }
});

test("aborted snapshots never start reset-credit reads", async () => {
  const { spyOn } = await import("bun:test");
  const api = await import("../../src/codex/auth-api");
  const { hubQuotaReaders } = await import("../../src/server/hub-quota-snapshot");
  const { captureMainAccountIdentityGeneration } = await import("../../src/codex/main-account-cache");
  const snapshot = spyOn(api, "listCodexAuthAccountsSnapshot").mockResolvedValue({ accounts: [{ ...rows[0], hasCredential: true }], mainIdentityGeneration: captureMainAccountIdentityGeneration() } as never);
  const controller = new AbortController(); controller.abort();
  const c = config(); c.codexAccounts = [{ id: "raw-secret-id", email: "person@example.test" }];
  try { await expect(hubQuotaReaders.openai(c, controller.signal)).rejects.toThrow(); }
  finally { snapshot.mockRestore(); }
});

test("Anthropic hub quota rejects same-slot credential replacement during probe", async () => {
  const { spyOn } = await import("bun:test");
  const store = await import("../../src/oauth/store");
  const { hubQuotaReaders } = await import("../../src/server/hub-quota-snapshot");
  let credential = { access: "fixture-old-access", refresh: "fixture-old-refresh", expires: Date.now() + 600_000 };
  const account = () => ({ id: "hub-anthropic-race", alias: "work", credential });
  const roster = spyOn(store, "getAccountSet").mockImplementation(() => ({ accounts: [account()], activeAccountId: "hub-anthropic-race" }) as never);
  const stored = spyOn(store, "getAccountCredential").mockImplementation(() => credential);
  const status = spyOn(store, "getAccountCredentialWithStatus").mockImplementation(() => ({ credential, paused: false, needsReauth: false }));
  const fetch = spyOn(globalThis, "fetch").mockImplementation(async () => {
    credential = { ...credential, access: "fixture-new-access", refresh: "fixture-new-refresh" };
    return Response.json({ five_hour: { utilization: 12 }, seven_day: { utilization: 20 } });
  });
  try { await expect(hubQuotaReaders.anthropic(config())).rejects.toThrow("Quota unavailable"); }
  finally { fetch.mockRestore(); stored.mockRestore(); status.mockRestore(); roster.mockRestore(); }
});

test("Anthropic hub quota never reuses another credential generation's cached quota", async () => {
  const { spyOn } = await import("bun:test");
  const store = await import("../../src/oauth/store");
  const { hubQuotaReaders } = await import("../../src/server/hub-quota-snapshot");
  let credential = { access: "fixture-cache-old", refresh: "fixture-refresh-old", expires: Date.now() + 600_000 };
  const roster = spyOn(store, "getAccountSet").mockImplementation(() => ({ accounts: [{ id: "hub-anthropic-cache", credential }], activeAccountId: "hub-anthropic-cache" }) as never);
  const stored = spyOn(store, "getAccountCredential").mockImplementation(() => credential);
  const status = spyOn(store, "getAccountCredentialWithStatus").mockImplementation(() => ({ credential, paused: false, needsReauth: false }));
  let count = 0;
  const fetch = spyOn(globalThis, "fetch").mockImplementation(async () => {
    count++;
    return Response.json({ five_hour: { utilization: count === 1 ? 12 : 54 } });
  });
  try {
    expect((await hubQuotaReaders.anthropic(config()))[0]!.quota?.fiveHourPercent).toBe(12);
    credential = { ...credential, access: "fixture-cache-new", refresh: "fixture-refresh-new" };
    expect((await hubQuotaReaders.anthropic(config()))[0]!.quota?.fiveHourPercent).toBe(54);
    expect(count).toBe(2);
  } finally { fetch.mockRestore(); stored.mockRestore(); status.mockRestore(); roster.mockRestore(); }
});

test("Anthropic hub quota binds credentials after normal token refresh", async () => {
  const { spyOn } = await import("bun:test");
  const store = await import("../../src/oauth/store");
  const oauth = await import("../../src/oauth");
  const { hubQuotaReaders } = await import("../../src/server/hub-quota-snapshot");
  let credential = { access: "fixture-expired", refresh: "fixture-refresh", expires: 1 };
  const roster = spyOn(store, "getAccountSet").mockImplementation(() => ({ accounts: [{ id: "hub-anthropic-refresh", credential }], activeAccountId: "hub-anthropic-refresh" }) as never);
  const stored = spyOn(store, "getAccountCredential").mockImplementation(() => credential);
  const status = spyOn(store, "getAccountCredentialWithStatus").mockImplementation(() => ({ credential, paused: false, needsReauth: false }));
  const refresh = spyOn(oauth, "getValidAccessTokenForAccount").mockImplementation(async () => {
    credential = { access: "fixture-refreshed", refresh: "fixture-refresh-new", expires: Date.now() + 600_000 };
    return credential.access;
  });
  const fetch = spyOn(globalThis, "fetch").mockImplementation(async () => Response.json({ five_hour: { utilization: 14 } }));
  try {
    expect((await hubQuotaReaders.anthropic(config()))[0]!.quota?.fiveHourPercent).toBe(14);
    expect(refresh).toHaveBeenCalledTimes(1);
  } finally { fetch.mockRestore(); refresh.mockRestore(); stored.mockRestore(); status.mockRestore(); roster.mockRestore(); }
});

test("Anthropic hub quota never joins an old credential's in-flight probe", async () => {
  const { spyOn } = await import("bun:test");
  const store = await import("../../src/oauth/store");
  const { hubQuotaReaders } = await import("../../src/server/hub-quota-snapshot");
  let credential = { access: "fixture-flight-old", refresh: "fixture-flight-refresh", expires: Date.now() + 600_000 };
  const roster = spyOn(store, "getAccountSet").mockImplementation(() => ({ accounts: [{ id: "hub-anthropic-flight", credential }], activeAccountId: "hub-anthropic-flight" }) as never);
  const stored = spyOn(store, "getAccountCredential").mockImplementation(() => credential);
  const status = spyOn(store, "getAccountCredentialWithStatus").mockImplementation(() => ({ credential, paused: false, needsReauth: false }));
  let entered!: () => void;
  let release!: () => void;
  const started = new Promise<void>(resolve => { entered = resolve; });
  const gate = new Promise<void>(resolve => { release = resolve; });
  let count = 0;
  const fetch = spyOn(globalThis, "fetch").mockImplementation(async () => {
    const old = ++count === 1;
    if (old) { entered(); await gate; }
    return Response.json({ five_hour: { utilization: old ? 12 : 54 } });
  });
  try {
    const first = hubQuotaReaders.anthropic(config()).then(() => "unexpected success", () => "rejected");
    await started;
    credential = { ...credential, access: "fixture-flight-new", refresh: "fixture-flight-new-refresh" };
    expect((await hubQuotaReaders.anthropic(config()))[0]!.quota?.fiveHourPercent).toBe(54);
    release();
    expect(await first).toBe("rejected");
    expect(count).toBe(2);
  } finally { release(); fetch.mockRestore(); stored.mockRestore(); status.mockRestore(); roster.mockRestore(); }
});

test("OpenAI account threshold override wins and explicit zero stays disabled", async () => {
  for (const [override, want] of [[25, 25], [0, 0], [null, 80]] as const) {
    const body = await (await handleHubQuota(request(), config(), { ...readers, openai: async () => [{ ...rows[0]!, autoSwitchThresholdOverride: override }] })).json();
    expect(body.providers.openai.accounts[0].autoSwitchThreshold).toBe(want);
  }
});

test("hub quota admission honors ingress key allowlist and its in-flight revocation", async () => {
  const c = config();
  const allowedKeyIds = new Set<string>();
  const policy = { ...c, linkIngress: { allowedKeyIds } };
  expect((await handleHubQuota(request(), c, readers, policy)).status).toBe(401);
  allowedKeyIds.add("client");
  expect((await handleHubQuota(request(), c, { ...readers, openai: async () => { allowedKeyIds.clear(); return rows; } }, policy)).status).toBe(401);
});

test("Anthropic hub quota binds bearer and ownership from one post-refresh account snapshot", async () => {
  const { spyOn } = await import("bun:test");
  const store = await import("../../src/oauth/store");
  const cache = await import("../../src/providers/quota/account-cache");
  const { fetchAnthropicHubAccountQuota } = await import("../../src/providers/quota/hub-anthropic");
  let credential = { access: "fixture-before-snapshot", refresh: "fixture-refresh", expires: Date.now() + 600_000 };
  const token = spyOn(cache, "getTokenForAccountQuotaProbe").mockResolvedValue(credential.access);
  const stored = spyOn(store, "getAccountCredential").mockImplementation(() => credential);
  const roster = spyOn(store, "getAccountSet").mockImplementation(() => {
    credential = { ...credential, access: "fixture-after-snapshot" };
    return { accounts: [{ id: "hub-one-snapshot", credential }], activeAccountId: "hub-one-snapshot" } as never;
  });
  const status = spyOn(store, "getAccountCredentialWithStatus").mockImplementation(() => ({ credential, paused: false, needsReauth: false }));
  const fetch = spyOn(globalThis, "fetch").mockImplementation(async () => Response.json({ five_hour: { utilization: 22 } }));
  try { await expect(fetchAnthropicHubAccountQuota("hub-one-snapshot")).rejects.toThrow("Quota unavailable"); }
  finally { token.mockRestore(); stored.mockRestore(); roster.mockRestore(); status.mockRestore(); fetch.mockRestore(); }
});
