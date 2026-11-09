/**
 * The soonest reset-credit expiry per Codex account, remembered from the last credit-list inspect.
 *
 * WHAM usage carries only `available_count` (stored as `StoredAccountQuota.resetCredits`); the
 * expiry of each credit comes from the separate reset-credit inspect. Every inspect this process
 * makes (the dashboard dialog, the auto-redeemer, the tray read's background refresh) is noted
 * here, so a passive read can show an expiry without asking upstream. A memo answers only while
 * its count still matches the stored count and it is younger than `RESET_CREDIT_EXPIRY_MEMO_TTL_MS`.
 * In memory only; a restart forgets it.
 */

export const RESET_CREDIT_EXPIRY_MEMO_TTL_MS = 12 * 60 * 60_000;

interface ResetCreditExpiryMemo {
  observedAt: number;
  count: number;
  soonestExpiresAt?: number;
}

const memos = new Map<string, ResetCreditExpiryMemo>();

/** Record one inspect result for `accountId`. */
export function noteResetCreditInspect(
  accountId: string,
  result: { credits: readonly { expires_at: string }[]; available_count?: number },
  now = Date.now(),
): void {
  let soonest: number | undefined;
  for (const credit of result.credits) {
    const expires = Date.parse(credit.expires_at);
    if (Number.isFinite(expires) && expires > now && (soonest === undefined || expires < soonest)) soonest = expires;
  }
  const count = typeof result.available_count === "number" && Number.isFinite(result.available_count)
    ? result.available_count
    : result.credits.length;
  memos.set(accountId, { observedAt: now, count, ...(soonest !== undefined ? { soonestExpiresAt: soonest } : {}) });
}

/**
 * The memo for `accountId` when it still describes `count` credits: `fresh` false means the
 * caller should inspect again. `soonestExpiresAt` is omitted once that moment has passed.
 */
export function peekResetCreditExpiry(accountId: string, count: number, now = Date.now()): { fresh: boolean; soonestExpiresAt?: number } {
  const memo = memos.get(accountId);
  if (!memo || memo.count !== count) return { fresh: false };
  const fresh = now - memo.observedAt < RESET_CREDIT_EXPIRY_MEMO_TTL_MS;
  return memo.soonestExpiresAt !== undefined && memo.soonestExpiresAt > now
    ? { fresh, soonestExpiresAt: memo.soonestExpiresAt }
    : { fresh: fresh && memo.soonestExpiresAt === undefined };
}

export function resetResetCreditExpiryMemoForTests(): void {
  memos.clear();
}
