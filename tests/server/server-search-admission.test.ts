import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { setCodexAccountPaused } from "../../src/codex/account-pause";
import { saveCodexAccountCredential } from "../../src/codex/account-store";
import { clearAccountNeedsReauth, clearAccountQuota } from "../../src/codex/auth-api";
import { clearCodexUpstreamHealth, clearThreadAccountMap } from "../../src/codex/routing";
import { loadConfig, saveConfig } from "../../src/config";
import { flushConfigDirHardeningForTests } from "../../src/config/paths";
import { startServer } from "../../src/server";
import { clearRequestLogsForTests, getRequestLogEntries } from "../../src/server/request-log";
import { handleSearch } from "../../src/server/search";
import type { OcxConfig } from "../../src/types";
import { usageLogPath } from "../../src/usage/log";
import { fakeChatGptJwt } from "../helpers/fake-chatgpt-jwt";
import { installIsolatedCodexHome, type IsolatedCodexHome } from "../helpers/isolated-codex-home";
import { removeTreeWithRetry } from "../helpers/remove-tree";

const TEST_DIR = join(import.meta.dir, ".tmp-search-admission");
const HUB_KEYS = ["ocx_data_search_fixture", "manual-search-fixture-key"];
const ADMIN_TOKEN = "ocx_admin_search_fixture";
const MODEL = "gpt-search-test";
const originalFetch = globalThis.fetch;
const previousEnv = {
  OPENCODEX_HOME: process.env.OPENCODEX_HOME,
  OPENCODEX_API_AUTH_TOKEN: process.env.OPENCODEX_API_AUTH_TOKEN,
  OPENCODEX_ADMIN_AUTH_TOKEN: process.env.OPENCODEX_ADMIN_AUTH_TOKEN,
};
let codexHome: IsolatedCodexHome | undefined;
let server: ReturnType<typeof startServer> | undefined;
let captured: { url: string; headers: Headers; body: unknown }[];

beforeEach(() => {
  mkdirSync(TEST_DIR, { recursive: true });
  process.env.OPENCODEX_HOME = TEST_DIR;
  delete process.env.OPENCODEX_API_AUTH_TOKEN;
  process.env.OPENCODEX_ADMIN_AUTH_TOKEN = ADMIN_TOKEN;
  codexHome = installIsolatedCodexHome("ocx-search-admission-");
  clearCodexUpstreamHealth();
  clearThreadAccountMap();
  clearAccountQuota();
  for (const accountId of ["pool-a", "pool-b"]) clearAccountNeedsReauth(accountId);
  clearRequestLogsForTests();
  captured = [];
  // Every external dispatch is mocked, including any accidental paid-backend fallback.
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const req = new Request(input, init);
    if (new URL(req.url).hostname === "127.0.0.1") return originalFetch(input, init);
    captured.push({ url: req.url, headers: req.headers, body: await req.json() });
    return Response.json({ encrypted_output: "fixture-ciphertext", output: "search result" });
  }) as typeof fetch;
});

afterEach(async () => {
  await server?.stop(true);
  server = undefined;
  globalThis.fetch = originalFetch;
  clearCodexUpstreamHealth();
  clearThreadAccountMap();
  clearAccountQuota();
  for (const accountId of ["pool-a", "pool-b"]) clearAccountNeedsReauth(accountId);
  clearRequestLogsForTests();
  await flushConfigDirHardeningForTests();
  codexHome?.restore();
  codexHome = undefined;
  for (const [key, value] of Object.entries(previousEnv)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  removeTreeWithRetry(TEST_DIR);
});

function poolConfig(): OcxConfig {
  return {
    port: 0,
    hostname: "0.0.0.0",
    defaultProvider: "openai",
    openaiProviderTierVersion: 2,
    providers: {
      openai: {
        adapter: "openai-responses",
        baseUrl: "https://chatgpt.com/backend-api/codex",
        authMode: "forward",
        codexAccountMode: "pool",
      },
      "openai-apikey": {
        adapter: "openai-responses",
        baseUrl: "https://api.openai.com/v1",
        apiKey: "paid-backend-fixture",
      },
    },
    apiKeys: HUB_KEYS.map((key, index) => ({
      id: `client-${index}`,
      name: `Client ${index}`,
      key,
      createdAt: "2026-01-01T00:00:00.000Z",
      allowedProviders: ["openai"],
      allowedModels: [MODEL],
    })),
    codexAccounts: [{ id: "pool-a", email: "a@example.test", isMain: false, chatgptAccountId: "acct-pool-a" }],
    activeCodexAccountId: "pool-a",
    webSearchSidecar: { backend: "exa", exaApiKey: "exa-fixture-key" },
  } as OcxConfig;
}

function saveAccount(accountId: string): void {
  saveCodexAccountCredential(accountId, {
    accessToken: `${accountId}-fixture-token`,
    refreshToken: `${accountId}-fixture-refresh`,
    expiresAt: Date.now() + 3_600_000,
    chatgptAccountId: `acct-${accountId}`,
  });
}

function start(config = poolConfig()): void {
  saveConfig(config);
  server = startServer(0);
}

function search(headers: Record<string, string> = {}, model = MODEL): Promise<Response> {
  return fetch(`http://127.0.0.1:${server!.port}/v1/alpha/search`, {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: JSON.stringify({ id: "search-fixture", model, commands: { search_query: [{ q: "fixture query" }] } }),
  });
}

function expectStoredAuth(accountId = "pool-a"): void {
  expect(captured).toHaveLength(1);
  expect(captured[0].url).toBe("https://chatgpt.com/backend-api/codex/alpha/search");
  expect(captured[0].headers.get("authorization")).toBe(`Bearer ${accountId}-fixture-token`);
  expect(captured[0].headers.get("chatgpt-account-id")).toBe(`acct-${accountId}`);
  expect(captured[0].headers.get("x-opencodex-api-key")).toBeNull();
  expect(captured[0].headers.get("x-api-key")).toBeNull();
  const wire = JSON.stringify({ ...captured[0], headers: [...captured[0].headers] });
  for (const key of HUB_KEYS) expect(wire).not.toContain(key);
}

test("scoped Hub Bearer keys use stored ChatGPT auth and retain separate attribution", async () => {
  saveAccount("pool-a");
  start();
  for (const key of HUB_KEYS) {
    captured = [];
    const response = await search({ authorization: `Bearer ${key}` });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ encrypted_output: "fixture-ciphertext", output: "search result" });
    expectStoredAuth();
  }
  expect(getRequestLogEntries().map(row => [row.admissionKind, row.apiKeyId]))
    .toEqual([["configured", "client-0"], ["configured", "client-1"]]);
  const rows = readFileSync(usageLogPath(), "utf8").trim().split("\n").map(line => JSON.parse(line));
  expect(rows.map(row => row.apiKeyId)).toEqual(["client-0", "client-1"]);
});

test.each([
  {},
  { authorization: "Bearer " + "ocx_data_invalid_fixture" },
  { authorization: "Bearer invalid-fixture" },
  { authorization: `Bearer ${ADMIN_TOKEN}` },
  { "x-opencodex-api-key": ADMIN_TOKEN },
  { authorization: "Bearer ocx_session_fixture" },
  { authorization: `Bearer ${HUB_KEYS[0]}`, "x-opencodex-api-key": "invalid-fixture" },
])("missing, invalid and management-only admission is refused: %j", async headers => {
  saveAccount("pool-a");
  start();
  expect((await search(headers)).status).toBe(401);
  expect(captured).toEqual([]);
});

test.each(["provider", "model"])("a scoped Hub Bearer cannot dispatch outside its %s scope", async scope => {
  saveAccount("pool-a");
  const config = poolConfig();
  if (scope === "provider") config.apiKeys![0].allowedProviders = ["anthropic"];
  else config.apiKeys![0].allowedModels = ["other-model"];
  start(config);
  const response = await search({ authorization: `Bearer ${HUB_KEYS[0]}` });
  expect(response.status).toBe(403);
  expect((await response.json()).error.type).toBe("model_not_allowed_for_key");
  expect(captured).toEqual([]);
});

test("dedicated Hub admission still selects stored auth without forwarding its key", async () => {
  saveAccount("pool-a");
  start();
  expect((await search({ "x-opencodex-api-key": HUB_KEYS[0] })).status).toBe(200);
  expectStoredAuth();
});

test("dedicated Hub admission retains intentional ChatGPT Direct forwarding", async () => {
  const config = poolConfig();
  config.providers.openai!.codexAccountMode = "direct";
  start(config);
  const token = fakeChatGptJwt({ chatgpt_account_id: "acct-caller" });
  const response = await search({
    "x-opencodex-api-key": HUB_KEYS[0],
    authorization: `Bearer ${token}`,
    "chatgpt-account-id": "acct-caller",
  });
  expect(response.status).toBe(200);
  expect(captured).toHaveLength(1);
  expect(captured[0].headers.get("authorization")).toBe(`Bearer ${token}`);
  expect(captured[0].headers.get("chatgpt-account-id")).toBe("acct-caller");
  expect(captured[0].headers.get("x-opencodex-api-key")).toBeNull();
});

test.each(["missing", "paused", "direct"])("%s stored auth cannot leak a Hub Bearer or spend another backend", async state => {
  const config = poolConfig();
  if (state !== "missing") saveAccount("pool-a");
  if (state === "paused") setCodexAccountPaused(config, "pool-a", true);
  if (state === "direct") config.providers.openai!.codexAccountMode = "direct";
  start(config);
  expect((await search({ authorization: `Bearer ${HUB_KEYS[0]}` })).status).toBe(401);
  expect(captured).toEqual([]);
});

test.each([true, false])("account-qualified Hub Bearer search preserves exact selection (credential available: %s)", async available => {
  const config = poolConfig();
  config.providers.openai!.codexAccountMode = "direct";
  config.codexAccounts!.push({ id: "pool-b", email: "b@example.test", isMain: false, chatgptAccountId: "acct-pool-b" });
  config.activeCodexAccountId = "pool-b";
  config.codexAccountNamespaces = { side: "pool-a" };
  saveAccount("pool-b");
  if (available) saveAccount("pool-a");
  start(config);
  const response = await search({ authorization: `Bearer ${HUB_KEYS[0]}` }, `side/${MODEL}`);
  expect(response.status).toBe(available ? 200 : 401);
  if (available) {
    expectStoredAuth("pool-a");
    expect(captured[0].body).toMatchObject({ model: MODEL });
  } else expect(captured).toEqual([]);
  expect(loadConfig().activeCodexAccountId).toBe("pool-b");
});

test("a Hub Bearer without validated bearer admission retains the forwarding guard", async () => {
  const config = poolConfig();
  saveAccount("pool-a");
  saveConfig(config);
  const response = await handleSearch(new Request("http://127.0.0.1/v1/alpha/search", {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${HUB_KEYS[0]}` },
    body: JSON.stringify({ model: MODEL }),
  }), config, { model: "web_search", provider: "unknown" });
  expect(response.status).toBe(401);
  expect((await response.json()).error.message).toContain("admission credentials");
  expect(captured).toEqual([]);
});

test("a dedicated admission does not reclassify a second Hub key as a caller bearer", async () => {
  saveAccount("pool-a");
  start();
  const response = await search({
    "x-opencodex-api-key": HUB_KEYS[0],
    authorization: `Bearer ${HUB_KEYS[1]}`,
  });
  expect(response.status).toBe(401);
  expect(captured).toEqual([]);
});
