/**
 * `GET /api/quota-pool`: the `ocx.quota-pool/1` read GOAT consumes (see src/quota-pool/), and
 * `GET /api/quota-pool/tray`: the `ocx.quota-tray/1` read the OpenCodexTray app renders.
 *
 * Same management authorization as the neighbouring reads; a Remote Link Child reaches it through
 * the read-only link relay (`LINK_MANAGEMENT_READ_PATHS`) and a Hub client through its hub relay.
 * Both reads are passive: there is no refresh form, so nothing here can make the Home probe. The
 * tray read may start a rate-limited background reset-credit inspect after it has answered
 * (`src/quota-pool/tray.ts`).
 */
import type { ManagementContext } from "./context";
import { jsonResponse } from "../auth-cors";

export async function handleQuotaPoolRoutes(ctx: ManagementContext): Promise<Response | null> {
  const { req, url, config } = ctx;
  // Any query (including a stray refresh=1) is ignored: the read has no active form.
  if (url.pathname === "/api/quota-pool" && req.method === "GET") {
    const { readQuotaPool } = await import("../../quota-pool/assemble");
    const result = await readQuotaPool(config);
    const response = result.ok
      ? jsonResponse(result.pool, 200, req, config)
      : jsonResponse({ error: result.error }, 503, req, config);
    response.headers.set("cache-control", "no-store");
    return response;
  }
  if (url.pathname === "/api/quota-pool/tray" && req.method === "GET") {
    const { readQuotaTray } = await import("../../quota-pool/tray");
    const result = await readQuotaTray(config);
    const response = result.ok
      ? jsonResponse(result.tray, 200, req, config)
      : jsonResponse({ error: result.error }, 503, req, config);
    response.headers.set("cache-control", "no-store");
    return response;
  }
  return null;
}
