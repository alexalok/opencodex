import { isDeclaredReasoningEffort } from "../../reasoning-effort";
import type { OcxConfig, OcxParsedRequest } from "../../types";

const SUBAGENT_HEADER = "x-openai-subagent";
const TURN_METADATA_HEADER = "x-codex-turn-metadata";

function record(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown> : undefined;
}

/**
 * Codex 0.164 sends `guardian` as its subagent label and `guardian_review` as its
 * thread source. `/review` instead sends `review`. Never infer approval review
 * from a model, prompt, or the generic `other` subagent kind.
 * HTTP copies must agree. WebSocket headers belong to the connection, so only
 * the current frame's client_metadata can classify a WebSocket request.
 */
export function isApprovalReviewRequest(body: unknown, headers: Headers, transport?: "websocket"): boolean {
  const clientValue = record(body)?.client_metadata;
  const client = record(clientValue);
  if (clientValue !== undefined && !client) return false;
  const labels: unknown[] = [];
  const metadata: unknown[] = [];
  if (transport !== "websocket") {
    if (headers.has(SUBAGENT_HEADER)) labels.push(headers.get(SUBAGENT_HEADER));
    if (headers.has(TURN_METADATA_HEADER)) metadata.push(headers.get(TURN_METADATA_HEADER));
  }
  if (client && Object.hasOwn(client, SUBAGENT_HEADER)) labels.push(client[SUBAGENT_HEADER]);
  if (client && Object.hasOwn(client, TURN_METADATA_HEADER)) metadata.push(client[TURN_METADATA_HEADER]);
  let guardian = false;
  for (const label of labels) {
    if (label !== "guardian") return false;
    guardian = true;
  }
  for (const value of metadata) {
    if (typeof value !== "string") return false;
    let turn: Record<string, unknown> | undefined;
    try { turn = record(JSON.parse(value)); } catch { return false; }
    if (!turn) return false;
    if (turn.request_kind !== undefined && turn.request_kind !== "turn") return false;
    if (turn.thread_source !== undefined) {
      if (turn.thread_source !== "guardian_review") return false;
      guardian = true;
    }
    if (turn.subagent_kind !== undefined && turn.subagent_kind !== "other") return false;
  }
  return guardian;
}

/** Apply after model pins and before destination normalization and effort caps. */
export function applyAutoReviewEffort(
  parsed: OcxParsedRequest,
  config: Pick<OcxConfig, "autoReviewOverride">,
): { from: string | undefined; to: string } | null {
  const setting = config.autoReviewOverride;
  const effort = setting?.reasoningEffort;
  if (!parsed._approvalReviewRequest || parsed._compactionRequest || setting?.enabled !== true
    || !effort || !isDeclaredReasoningEffort(effort)) return null;
  const from = parsed.options.reasoning;
  if (from === effort) return null;
  parsed.options.reasoning = effort;
  const raw = record(parsed._rawBody);
  if (raw) raw.reasoning = { ...record(raw.reasoning), effort };
  return { from, to: effort };
}
