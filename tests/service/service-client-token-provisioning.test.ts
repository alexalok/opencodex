import { afterEach, beforeEach, expect, spyOn, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfig } from "../../src/config";
import { createLinkKeySource } from "../../src/client/link-ingress";
import { serviceApiTokenFilePath, serviceApiTokenFingerprint } from "../../src/lib/service-secrets";
import { writeServiceApiTokenFile } from "../../src/service/guards";
import { removeTreeWithRetry } from "../helpers/remove-tree";

const key = "ocx_test_current_client_key";
const stale = "ocx_test_stale_client_key";
let home: string;
let previousHome: string | undefined;
let previousToken: string | undefined;
let log: ReturnType<typeof spyOn>;
let warn: ReturnType<typeof spyOn>;

beforeEach(() => {
  previousHome = process.env.OPENCODEX_HOME;
  previousToken = process.env.OPENCODEX_API_AUTH_TOKEN;
  home = mkdtempSync(join(tmpdir(), "ocx-client-provision-"));
  process.env.OPENCODEX_HOME = home;
  process.env.OPENCODEX_API_AUTH_TOKEN = stale;
  log = spyOn(console, "log").mockImplementation(() => {});
  warn = spyOn(console, "warn").mockImplementation(() => {});
});

afterEach(() => {
  log.mockRestore();
  warn.mockRestore();
  if (previousHome === undefined) delete process.env.OPENCODEX_HOME;
  else process.env.OPENCODEX_HOME = previousHome;
  if (previousToken === undefined) delete process.env.OPENCODEX_API_AUTH_TOKEN;
  else process.env.OPENCODEX_API_AUTH_TOKEN = previousToken;
  removeTreeWithRetry(home);
});

function configure(role: "client" | "standalone" | "hub", hostname = "127.0.0.1"): void {
  writeFileSync(join(home, "config.json"), JSON.stringify({
    port: 10100, hostname, providers: { openai: { adapter: "openai-chat", baseUrl: "https://api.example.test/v1" } }, defaultProvider: "openai", runtimeRole: role,
    ...(role === "client" ? { client: {
      serverUrl: "http://127.0.0.1:23456", managementUrl: "http://127.0.0.1:23456",
      managementTransport: "direct", transport: "link",
      link: { tunnelPort: 23456, linkId: "lnk_0123456789abcdef" },
      selectedClients: ["codex"], tokenEnv: "OPENCODEX_API_AUTH_TOKEN", apiKeyId: "test-client",
      tokenFingerprint: serviceApiTokenFingerprint(key), protocolVersion: 1,
      connectedAt: "2026-10-01T00:00:00.000Z",
    } } : {}),
  }));
  if (role === "client") expect(loadConfig().client?.tokenFingerprint).toBe(serviceApiTokenFingerprint(key));
}

for (const hostname of ["127.0.0.1", "0.0.0.0"]) {
  test(`keeps the link client's matching key despite stale env on ${hostname}`, () => {
    configure("client", hostname);
    const path = serviceApiTokenFilePath();
    writeFileSync(path, `${key}\n`, { mode: 0o600 });
    expect(writeServiceApiTokenFile()).toEqual({ path, origin: "file" });
    expect(readFileSync(path, "utf8")).toBe(`${key}\n`);
    expect(createLinkKeySource(serviceApiTokenFingerprint(key))()).toBe(key);
    const output = JSON.stringify([...log.mock.calls, ...warn.mock.calls]);
    expect(output).toContain("OPENCODEX_API_AUTH_TOKEN");
    expect(output).toContain("ignored");
    expect(output).not.toContain(key);
    expect(output).not.toContain(stale);
  });
}

for (const existing of [undefined, "ocx_test_unrelated_key", ""]) {
  test(`refuses a stale env key without a matching file (${existing === undefined ? "absent" : existing ? "mismatched" : "empty"})`, () => {
    configure("client");
    const path = serviceApiTokenFilePath();
    if (existing !== undefined) writeFileSync(path, existing);
    expect(() => writeServiceApiTokenFile()).toThrow("OPENCODEX_API_AUTH_TOKEN");
    if (existing === undefined) expect(existsSync(path)).toBe(false);
    else expect(readFileSync(path, "utf8")).toBe(existing);
  });
}

for (const role of ["standalone", "hub"] as const) {
  test(`${role} retains explicit env precedence`, () => {
    configure(role, "0.0.0.0");
    const path = serviceApiTokenFilePath();
    writeFileSync(path, `${key}\n`);
    expect(writeServiceApiTokenFile()).toEqual({ path, origin: "env" });
    expect(readFileSync(path, "utf8")).toBe(`${stale}\n`);
  });
}

test("a matching env key can restore the client file", () => {
  configure("client");
  process.env.OPENCODEX_API_AUTH_TOKEN = key;
  expect(writeServiceApiTokenFile()?.origin).toBe("env");
  expect(createLinkKeySource(serviceApiTokenFingerprint(key))()).toBe(key);
});

test("admin env refusal still precedes reuse of a matching client file", () => {
  configure("client");
  const path = serviceApiTokenFilePath();
  writeFileSync(path, `${key}\n`);
  process.env.OPENCODEX_API_AUTH_TOKEN = "ocx_admin_test_not_a_data_key";
  expect(() => writeServiceApiTokenFile()).toThrow("management (admin) token");
  expect(readFileSync(path, "utf8")).toBe(`${key}\n`);
});
