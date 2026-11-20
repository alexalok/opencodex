import { createHmac, randomBytes } from "node:crypto";

type QuotaRow = { plan?: string | null; quota?: { weeklyResetAt?: number } | null };
const key = randomBytes(32);
const identities = new WeakMap<object, { fingerprint: string; plan: string; reset?: number; isCurrent?: () => boolean }>();

/** Capture immutable private identity with the DTO; never attach it to serialized fields. */
export function captureCodexQuotaIdentity<T extends QuotaRow>(row: T, rawEmail: string | null | undefined, isCurrent?: () => boolean): T {
  const email = rawEmail?.trim().toLowerCase();
  identities.set(row, { fingerprint: email?.includes("@") ? createHmac("sha256", key).update(email).digest("hex") : "",
    plan: row.plan?.trim().toLowerCase() ?? "", reset: row.quota?.weeklyResetAt, isCurrent });
  return row;
}

export function isCodexQuotaIdentityCurrent(row: object): boolean {
  return identities.get(row)?.isCurrent?.() !== false;
}

export function sameCodexQuotaIdentity(left: object, right: object): boolean {
  const a = identities.get(left);
  const b = identities.get(right);
  return !!a?.fingerprint && !!a.plan && !!b && a.fingerprint === b.fingerprint && a.plan === b.plan
    && typeof a.reset === "number" && Number.isFinite(a.reset) && a.reset > 0
    && typeof b.reset === "number" && Number.isFinite(b.reset) && b.reset > 0 && Math.abs(a.reset - b.reset) <= 2;
}
