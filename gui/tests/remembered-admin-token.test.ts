import { afterEach, beforeEach, expect, spyOn, test } from "bun:test";
import { Window } from "happy-dom";
import { configureApiTargets, installApiAuthFetch, logoutApiSession, resetApiAuthFetchForTests } from "../src/api";
import { standaloneApiTargets } from "../src/api-targets";
import { ADMIN_TOKEN_RETENTION_MS } from "../src/remembered-admin-token";

const TOKEN = "ocx_admin_remembered_fixture";
const ORIGIN = "https://dashboard.example.test";
const globals = ["window", "document", "sessionStorage"] as const;
let previous: unknown[];
let browser: Window;
let now: number;
let clock: ReturnType<typeof spyOn<typeof Date, "now">>;
let serverToken: string;
let enteredToken: string | null;
let prompts: number;
let validationStatus: number | null;
let requests: { path: string; token: string | null }[];
let beforeValidation: (() => Promise<void>) | null;

beforeEach(() => {
  previous = globals.map(key => globalThis[key]);
  browser = new Window({ url: `${ORIGIN}/` });
  globals.forEach(key => Object.defineProperty(globalThis, key, { configurable: true, value: key === "window" ? browser : browser[key] }));
  document.head.innerHTML = '<meta name="opencodex-management-auth-required" content="1">';
  now = Date.now();
  clock = spyOn(Date, "now").mockImplementation(() => now);
  serverToken = TOKEN;
  enteredToken = TOKEN;
  prompts = 0;
  validationStatus = null;
  requests = [];
  beforeValidation = null;
});

afterEach(() => {
  resetApiAuthFetchForTests();
  clock.mockRestore();
  browser.close();
  globals.forEach((key, index) => Object.defineProperty(globalThis, key, { configurable: true, value: previous[index] }));
});

function reload(): void {
  resetApiAuthFetchForTests(async verify => {
    prompts++;
    return enteredToken && await verify(enteredToken) === "accepted" ? enteredToken : null;
  });
  Object.defineProperty(window, "fetch", { configurable: true, writable: true, value: async (input: RequestInfo | URL, init?: RequestInit) => {
    const path = new URL(input instanceof Request ? input.url : String(input), ORIGIN).pathname;
    const token = new Headers(init?.headers).get("X-OpenCodex-API-Key");
    requests.push({ path, token });
    if (path === "/opencodex-session") return new Response("", { status: 401 });
    if (path === "/api/combos") {
      await beforeValidation?.();
      if (validationStatus !== null) return new Response("", { status: validationStatus });
    }
    return new Response("{}", { status: token === serverToken ? 200 : 401 });
  } });
  installApiAuthFetch();
}

function saved(): { key: string; token: string; expiresAt: number } | null {
  const storage = window.localStorage;
  const key = Object.keys(storage).find(key => key.startsWith("opencodex-admin-token:"));
  return key ? { key, ...JSON.parse(storage.getItem(key)!) } : null;
}

async function login(): Promise<void> {
  reload();
  expect((await window.fetch("/api/config")).status).toBe(200);
}

test("validated admin login is remembered for exactly 365 days", async () => {
  await login();
  expect(prompts).toBe(1);
  expect(saved()).toMatchObject({ token: TOKEN, expiresAt: now + ADMIN_TOKEN_RETENTION_MS });
  expect(window.sessionStorage.length).toBe(0);
});

test("reload and server restart recover the login without extending its expiry", async () => {
  await login();
  const expiry = saved()!.expiresAt;
  now += ADMIN_TOKEN_RETENTION_MS - 1;
  prompts = 0;
  enteredToken = null;
  reload();
  expect((await window.fetch("/api/config")).status).toBe(200);
  expect(prompts).toBe(0);
  expect(saved()!.expiresAt).toBe(expiry);
});

test("an expired saved token is removed without being sent to the server", async () => {
  await login();
  now += ADMIN_TOKEN_RETENTION_MS;
  enteredToken = null;
  requests = [];
  reload();
  expect((await window.fetch("/api/config")).status).toBe(401);
  expect(saved()).toBeNull();
  expect(requests.every(request => request.token === null)).toBe(true);
});

test("expiry also clears the token in an already-open dashboard", async () => {
  await login();
  now += ADMIN_TOKEN_RETENTION_MS;
  enteredToken = null;
  requests = [];
  expect((await window.fetch("/api/config")).status).toBe(401);
  expect(saved()).toBeNull();
  expect(requests.every(request => request.token === null)).toBe(true);
});

test("a rotated token is discarded before asking for and saving its replacement", async () => {
  await login();
  serverToken = enteredToken = "ocx_admin_rotated_fixture";
  requests = [];
  reload();
  expect((await window.fetch("/api/config", { method: "POST" })).status).toBe(200);
  expect(saved()!.token).toBe(serverToken);
  expect(requests).toContainEqual({ path: "/api/combos", token: TOKEN });
  expect(requests).not.toContainEqual({ path: "/api/config", token: TOKEN });
});

test("a rejected newly entered token is never saved", async () => {
  enteredToken = "ocx_admin_wrong_fixture";
  reload();
  expect((await window.fetch("/api/config")).status).toBe(401);
  expect(saved()).toBeNull();
});

test("logout clears the remembered login and prevents recovery after reload", async () => {
  await login();
  expect(await logoutApiSession("shared")).toBe(true);
  expect(saved()).toBeNull();
  enteredToken = null;
  reload();
  expect((await window.fetch("/api/config")).status).toBe(401);
});

test("storage denial still allows a login for the current page", async () => {
  Object.defineProperty(window, "localStorage", { configurable: true, get() { throw new DOMException("disabled", "SecurityError"); } });
  await login();
  expect((await window.fetch("/api/config")).status).toBe(200);
  expect(prompts).toBe(1);
});

test.each(["not-json", "null", "[]", '{"token":42,"expiresAt":99}', '{"token":"ocx_session_fixture","expiresAt":9999999999999}'])("malformed saved credentials are discarded: %s", async value => {
  await login();
  window.localStorage.setItem(saved()!.key, value);
  enteredToken = null;
  requests = [];
  reload();
  expect((await window.fetch("/api/config")).status).toBe(401);
  expect(saved()).toBeNull();
  expect(requests.every(request => request.token === null)).toBe(true);
});

test("another server cannot inherit the remembered admin token", async () => {
  await login();
  enteredToken = null;
  reload();
  const targets = standaloneApiTargets("");
  configureApiTargets({ ...targets, connected: true, shared: { id: "shared", baseUrl: "https://hub.example.test",
    serverOrigin: "https://hub.example.test", bootstrapPath: "https://hub.example.test/opencodex-session", transport: "direct" } });
  requests = [];
  expect((await window.fetch("https://hub.example.test/api/config")).status).toBe(401);
  expect(requests.every(request => request.token === null)).toBe(true);
  configureApiTargets(targets);
  expect((await window.fetch("/api/config")).status).toBe(200);
});

test("short-lived GUI sessions remain memory-only", async () => {
  serverToken = "ocx_session_injected_fixture";
  for (const [name, content] of [["token", serverToken], ["csrf", "csrf_fixture"], ["origin", ORIGIN], ["server-origin", ORIGIN]]) {
    const meta = document.createElement("meta");
    meta.name = `opencodex-session-${name}`;
    meta.content = content;
    document.head.append(meta);
  }
  reload();
  expect((await window.fetch("/api/config")).status).toBe(200);
  expect(saved()).toBeNull();
  expect(prompts).toBe(0);
});

test("concurrent requests share remembered-token verification without prompting", async () => {
  await login();
  enteredToken = null;
  prompts = 0;
  requests = [];
  reload();
  const responses = await Promise.all(["/api/config", "/api/models", "/api/providers"].map(path => window.fetch(path)));
  expect(responses.map(response => response.status)).toEqual([200, 200, 200]);
  expect(requests.filter(request => request.path === "/api/combos")).toHaveLength(1);
  expect(prompts).toBe(0);
});

test("a temporary server failure retains the login without opening another token prompt", async () => {
  await login();
  prompts = 0;
  enteredToken = null;
  validationStatus = 503;
  reload();
  expect((await window.fetch("/api/config")).status).toBe(401);
  expect(saved()!.token).toBe(TOKEN);
  expect(prompts).toBe(0);
  validationStatus = null;
  expect((await window.fetch("/api/config")).status).toBe(200);
});

test("logout while remembered-token validation is pending cannot resurrect the login", async () => {
  await login();
  reload();
  let release!: () => void;
  let started!: () => void;
  const pending = new Promise<void>(resolve => { release = resolve; });
  const validating = new Promise<void>(resolve => { started = resolve; });
  beforeValidation = () => { started(); return pending; };
  const response = window.fetch("/api/config");
  await validating;
  await logoutApiSession("shared");
  release();
  expect((await response).status).toBe(401);
  expect(saved()).toBeNull();
});
