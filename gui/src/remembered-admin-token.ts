import type { ApiTarget } from "./api-targets";

export const ADMIN_TOKEN_RETENTION_MS = 365 * 24 * 60 * 60 * 1000;
const STORAGE_PREFIX = "opencodex-admin-token:";

export interface RememberedAdminToken {
  token: string;
  expiresAt: number;
}

function storageKey(target: ApiTarget): string {
  const base = new URL(target.baseUrl || "/", window.location.href).href.replace(/\/$/, "");
  // Browser storage already isolates the page origin. Also isolate servers, base paths
  // and transports so a connected target never inherits another server's credential.
  return STORAGE_PREFIX + JSON.stringify([target.serverOrigin, base, target.transport]);
}

export function readRememberedAdminToken(target: ApiTarget, now = Date.now()): RememberedAdminToken | null {
  try {
    const key = storageKey(target);
    const stored = window.localStorage.getItem(key);
    if (!stored) return null;
    let record: RememberedAdminToken | null = null;
    try { record = JSON.parse(stored); } catch { /* discard malformed storage below */ }
    if (!record || typeof record.token !== "string" || !record.token.trim()
      || record.token.startsWith("ocx_session_") || !Number.isSafeInteger(record.expiresAt)
      || record.expiresAt <= now || record.expiresAt > now + ADMIN_TOKEN_RETENTION_MS) {
      window.localStorage.removeItem(key);
      return null;
    }
    return record;
  } catch { return null; /* storage may be disabled */ }
}

/** Call only after an explicitly entered admin token has passed server validation. */
export function rememberAdminToken(target: ApiTarget, token: string, now = Date.now()): RememberedAdminToken | null {
  if (!token.trim() || token.startsWith("ocx_session_")) return null;
  const record = { token, expiresAt: now + ADMIN_TOKEN_RETENTION_MS };
  try { window.localStorage.setItem(storageKey(target), JSON.stringify(record)); }
  catch { /* keep the current login usable when storage is unavailable */ }
  return record;
}

export function forgetRememberedAdminToken(target: ApiTarget, expectedToken?: string): void {
  try {
    if (expectedToken !== undefined && readRememberedAdminToken(target)?.token !== expectedToken) return;
    window.localStorage.removeItem(storageKey(target));
  } catch { /* storage may be disabled */ }
}
