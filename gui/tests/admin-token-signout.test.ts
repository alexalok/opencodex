import { afterEach, beforeEach, expect, test } from "bun:test";
import { Window } from "happy-dom";
import { configureApiTargets, hasAdminTokenLogin, hasApiSession, installApiAuthFetch, resetApiAuthFetchForTests } from "../src/api";
import { standaloneApiTargets } from "../src/api-targets";
import { logoutAdminTokenLogins } from "../src/use-admin-token-login";

const TOKEN = "ocx_admin_signout_fixture";
const ORIGIN = "https://dashboard.example.test";
const globals = ["window", "document", "sessionStorage"] as const;
let previous: unknown[];
let browser: Window;
let enteredToken: string | null;

beforeEach(() => {
  previous = globals.map(key => globalThis[key]);
  browser = new Window({ url: `${ORIGIN}/` });
  globals.forEach(key => Object.defineProperty(globalThis, key, { configurable: true, value: key === "window" ? browser : browser[key] }));
  document.head.innerHTML = '<meta name="opencodex-management-auth-required" content="1">';
  enteredToken = TOKEN;
});

afterEach(() => {
  resetApiAuthFetchForTests();
  browser.close();
  globals.forEach((key, index) => Object.defineProperty(globalThis, key, { configurable: true, value: previous[index] }));
});

function reload(): void {
  resetApiAuthFetchForTests(async verify => enteredToken && await verify(enteredToken) === "accepted" ? enteredToken : null);
  Object.defineProperty(window, "fetch", { configurable: true, writable: true, value: async (input: RequestInfo | URL, init?: RequestInit) => {
    const path = new URL(input instanceof Request ? input.url : String(input), ORIGIN).pathname;
    if (path === "/opencodex-session") return new Response("", { status: 401 });
    return new Response("{}", { status: new Headers(init?.headers).get("X-OpenCodex-API-Key") === TOKEN ? 200 : 401 });
  } });
  configureApiTargets(standaloneApiTargets(""));
  installApiAuthFetch();
}

function remembered(): boolean {
  return Object.keys(window.localStorage).some(key => key.startsWith("opencodex-admin-token:"));
}

test("an admin-token login is visible to the sign-out control, which forgets it", async () => {
  reload();
  expect((await window.fetch("/api/config")).status).toBe(200);
  // The minted-session check alone hid the sign-out control for this login.
  expect(hasApiSession("shared")).toBe(false);
  expect(hasAdminTokenLogin("shared")).toBe(true);
  expect(remembered()).toBe(true);
  expect(await logoutAdminTokenLogins()).toBe(true);
  expect(hasAdminTokenLogin("shared")).toBe(false);
  expect(remembered()).toBe(false);
  expect(await logoutAdminTokenLogins()).toBe(false);
  enteredToken = null;
  reload();
  expect((await window.fetch("/api/config")).status).toBe(401);
});
