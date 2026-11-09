/**
 * The soonest reset-credit expiry per Codex account, remembered from the last credit-list inspect.
 *
 * WHAM usage carries only `available_count` (stored as `StoredAccountQuota.resetCredits`); the
 * expiry of each credit comes from the separate reset-credit inspect. Every inspect this process
 * makes (the dashboard dialog, the auto-redeemer, the tray read's background refresh) is noted
 * here, so a passive read can show an expiry without asking upstream. A memo answers only while
 * its count still matches the stored count and it is younger than `RESET_CREDIT_EXPIRY_MEMO_TTL_MS`.
 * In memory only; a restart forgets it.
 *
 * The native main login is one logical id (`__main__`) for whichever physical account is signed
 * in, so its memo is bound to the main identity generation the inspect ran under: a result from a
 * superseded identity is never recorded, and a recorded memo stops answering once the identity moves.
 */
import { MAIN_CODEX_ACCOUNT_ID } from "./account-id";
import { isMainAccountIdentityGenerationLive } from "./main-account-cache";

export const RESET_CREDIT_EXPIRY_MEMO_TTL_MS = 12 * 60 * 60_000;

interface ResetCreditExpiryMemo {
  observedAt: number;
  count: number;
  soonestExpiresAt?: number;
  mainIdentityGeneration?: number;
}

const memos = new Map<string, ResetCreditExpiryMemo>();

const mainIdentityLive = (generation: number | undefined) =>
  generation !== undefined && isMainAccountIdentityGenerationLive(generation);

/**
 * Record one inspect result for `accountId`. For `__main__`, `mainIdentityGeneration` is the
 * physical identity the inspect was made for; without a live one the result is dropped.
 */
export function noteResetCreditInspect(
  accountId: string,
  result: { credits: readonly { expires_at: string }[]; available_count?: number },
  now = Date.now(),
  mainIdentityGeneration?: number,
): void {
  const main = accountId === MAIN_CODEX_ACCOUNT_ID;
  if (main && !mainIdentityLive(mainIdentityGeneration)) {
    memos.delete(accountId);
    return;
  }
  let soonest: number | undefined;
  for (const credit of result.credits) {
    const expires = Date.parse(credit.expires_at);
    if (Number.isFinite(expires) && expires > now && (soonest === undefined || expires < soonest)) soonest = expires;
  }
  const count = typeof result.available_count === "number" && Number.isFinite(result.available_count)
    ? result.available_count
    : result.credits.length;
  memos.set(accountId, {
    observedAt: now,
    count,
    ...(soonest !== undefined ? { soonestExpiresAt: soonest } : {}),
    ...(main ? { mainIdentityGeneration } : {}),
  });
}

/**
 * The memo for `accountId` when it still describes `count` credits: `fresh` false means the
 * caller should inspect again. `soonestExpiresAt` is omitted once that moment has passed.
 */
export function peekResetCreditExpiry(accountId: string, count: number, now = Date.now()): { fresh: boolean; soonestExpiresAt?: number } {
  const memo = memos.get(accountId);
  if (!memo || memo.count !== count) return { fresh: false };
  if (accountId === MAIN_CODEX_ACCOUNT_ID && !mainIdentityLive(memo.mainIdentityGeneration)) return { fresh: false };
  const fresh = now - memo.observedAt < RESET_CREDIT_EXPIRY_MEMO_TTL_MS;
  return memo.soonestExpiresAt !== undefined && memo.soonestExpiresAt > now
    ? { fresh, soonestExpiresAt: memo.soonestExpiresAt }
    : { fresh: fresh && memo.soonestExpiresAt === undefined };
}

export function resetResetCreditExpiryMemoForTests(): void {
  memos.clear();
}
