import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { applyAutoReviewEffort, isApprovalReviewRequest } from "../../src/server/responses/auto-review-effort";
import { handleResponses } from "../../src/server/responses";
import { getDefaultConfig, validateConfigCandidate } from "../../src/config";
import { configSchema } from "../../src/config/schema/config-schema";
import { sanitizeAutoReviewForLoad } from "../../src/config/load-degrade";
import { acquireOwnedSpendHome } from "../helpers/owned-spend-home";
import type { OcxConfig, OcxParsedRequest } from "../../src/types";

const guardian = { "x-openai-subagent": "guardian" };
const turn = (source = "guardian_review") => JSON.stringify({ request_kind: "turn", thread_source: source });
const originalFetch = globalThis.fetch;
let release: (() => void) | undefined;
beforeEach(() => { release = acquireOwnedSpendHome(); });
afterEach(() => { release?.(); globalThis.fetch = originalFetch; });

function config(): OcxConfig {
  return { ...getDefaultConfig(), defaultProvider: "gateway", providers: {
    gateway: { adapter: "openai-responses", authMode: "key", baseUrl: "https://gateway.example/v1", apiKey: "fixture-key" },
  }, autoReviewOverride: { enabled: true, model: "gateway/gpt-6-luna", reasoningEffort: "high" } };
}
function body(client_metadata?: unknown) {
  return { model: "gateway/gpt-6-luna", stream: false, reasoning: { effort: "low", summary: "auto" },
    input: [{ type: "message", role: "user", content: [{ type: "input_text", text: "Check this action." }] }],
    ...(client_metadata === undefined ? {} : { client_metadata }) };
}

describe("approval review detection", () => {
  test("accepts exact HTTP and per-frame markers from Codex", () => {
    expect(isApprovalReviewRequest(body(), new Headers(guardian))).toBe(true);
    expect(isApprovalReviewRequest(body(guardian), new Headers(), "websocket")).toBe(true);
    expect(isApprovalReviewRequest(body(), new Headers({ "x-codex-turn-metadata": turn() }))).toBe(true);
    expect(isApprovalReviewRequest(body({ ...guardian, "x-codex-turn-metadata": turn() }), new Headers(guardian))).toBe(true);
    expect(isApprovalReviewRequest(body({ "x-codex-turn-metadata": turn() }), new Headers(), "websocket")).toBe(true);
  });
  test("never infers review from model, prompt, or a connection header on websocket", () => {
    expect(isApprovalReviewRequest(body(), new Headers())).toBe(false);
    expect(isApprovalReviewRequest(body(), new Headers(guardian), "websocket")).toBe(false);
    for (const label of ["review", "collab_spawn", "compact", "memory_consolidation", "other", "guardian-extra"]) {
      expect(isApprovalReviewRequest(body(), new Headers({ "x-openai-subagent": label }))).toBe(false);
    }
    expect(isApprovalReviewRequest(body({ "x-codex-turn-metadata": JSON.stringify({ subagent_kind: "other" }) }), new Headers())).toBe(false);
  });
  test("rejects conflicting or malformed metadata instead of broadening the override", () => {
    for (const value of [null, "bad", [], 3]) expect(isApprovalReviewRequest(body(value), new Headers(guardian))).toBe(false);
    for (const value of ["broken", "[]", "null", turn("user"), turn("subagent"), JSON.stringify({ request_kind: "memory" })]) {
      expect(isApprovalReviewRequest(body({ "x-codex-turn-metadata": value }), new Headers(guardian))).toBe(false);
    }
    expect(isApprovalReviewRequest(body({ "x-openai-subagent": "review" }), new Headers(guardian))).toBe(false);
    expect(isApprovalReviewRequest(body({ "x-codex-turn-metadata": turn() }), new Headers({ "x-codex-turn-metadata": turn("user") }))).toBe(false);
    // A later ordinary frame must not inherit the first frame's guardian handshake.
    expect(isApprovalReviewRequest(body({ "x-codex-turn-metadata": turn("user") }), new Headers(guardian), "websocket")).toBe(false);
  });
});

test("configuration validates effort and degrades a malformed block without losing other settings", () => {
  expect(validateConfigCandidate(config()).ok).toBe(true);
  expect((configSchema.parse(config()) as OcxConfig).autoReviewOverride?.reasoningEffort).toBe("high");
  const malformed = { ...config(), autoReviewOverride: { enabled: true, reasoningEffort: "invalid" } };
  expect(validateConfigCandidate(malformed).ok).toBe(false);
  sanitizeAutoReviewForLoad(malformed);
  expect(malformed.autoReviewOverride).toBeUndefined();
  expect(malformed.providers.gateway).toBeDefined();
});

test("the rewrite preserves reasoning siblings and is off by default", () => {
  const parsed = { _approvalReviewRequest: true, options: { reasoning: "low" }, _rawBody: body() } as OcxParsedRequest;
  expect(applyAutoReviewEffort(parsed, {})).toBeNull();
  expect(applyAutoReviewEffort(parsed, { autoReviewOverride: { enabled: false, reasoningEffort: "high" } })).toBeNull();
  expect(applyAutoReviewEffort(parsed, config())).toEqual({ from: "low", to: "high" });
  expect((parsed._rawBody as ReturnType<typeof body>).reasoning).toEqual({ effort: "high", summary: "auto" });
  expect(parsed.options.reasoning).toBe("high");
});

test("the real Responses path changes only marked review turns and honors disabling/clearing", async () => {
  const calls: Array<{ reasoning: { effort: string; summary: string } }> = [];
  globalThis.fetch = (async (_input: unknown, init?: RequestInit) => {
    calls.push(JSON.parse(String(init?.body)));
    return Response.json({ id: "resp_review_fixture", status: "completed", output: [
      { type: "message", role: "assistant", content: [{ type: "output_text", text: "ok" }] },
    ], usage: { input_tokens: 10, output_tokens: 5, total_tokens: 15 } });
  }) as typeof fetch;
  const settings = config();
  async function send(headers: Record<string, string>, client?: unknown, websocket = false) {
    const req = new Request("http://localhost/v1/responses", { method: "POST", headers: { "content-type": "application/json", ...headers }, body: JSON.stringify(body(client)) });
    const response = await handleResponses(req, settings, { model: "", provider: "" }, websocket ? { inboundTransport: "websocket" } : {});
    expect(response.status).toBe(200);
    await response.text();
  }
  await send(guardian);
  await send({});
  await send({ "x-openai-subagent": "review" });
  await send(guardian, guardian, true);
  await send(guardian, { "x-codex-turn-metadata": turn("user") }, true);
  settings.autoReviewOverride!.enabled = false;
  await send(guardian);
  settings.autoReviewOverride!.enabled = true;
  delete settings.autoReviewOverride!.reasoningEffort;
  await send(guardian);
  expect(calls.map(call => call.reasoning.effort)).toEqual(["high", "low", "low", "high", "low", "low", "low"]);
  expect(calls[0]!.reasoning.summary).toBe("auto");
});
