import { createHmac, randomBytes } from "node:crypto";
import { hubQuotaReaders, MAX_HUB_QUOTA_ACCOUNTS, type HubQuotaAccount, type HubQuotaReaders, type HubQuotaSnapshot } from "./hub-quota-snapshot";
import type { OcxConfig, OcxApiKeyEntry } from "../types";
import { isAllowedRequestOrigin, resolveDataPlaneAdmissionSecret, type RequestPolicyView } from "./auth-cors";

const reply = (body: unknown, status = 200) => Response.json(body, {
  status, headers: { "Cache-Control": "no-store", ...(status === 405 ? { Allow: "GET" } : {}) },
});

function permittedKey(req: Request, config: OcxConfig, policy: RequestPolicyView): OcxApiKeyEntry | Response {
  const admission = resolveDataPlaneAdmissionSecret(req.headers.get("x-opencodex-api-key") ?? "", config, "dedicated", { linkIngress: policy.linkIngress?.allowedKeyIds });
  if (admission?.kind !== "configured") return reply({ error: "Configured API key required" }, 401);
  const key = config.apiKeys?.find(entry => entry.id === admission.keyId);
  if (key?.allowQuotaRead !== true) return reply({ error: "Quota read permission required" }, 403);
  const validScope = (value: unknown) => value === undefined
    || (Array.isArray(value) && value.every(item => typeof item === "string" && item.trim().length > 0));
  if (!validScope(key.allowedProviders) || !validScope(key.allowedModels) || key.allowedModels?.length) {
    return reply({ error: "Unsupported quota scope" }, 403);
  }
  return key;
}

const projectionKey = randomBytes(32);
const providerNames = ["openai", "anthropic"] as const;
type Provider = typeof providerNames[number];
const percent = (value: unknown): number | null => typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= 100 ? value : null;
function label(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 && value.length <= 128
    && !/[\x00-\x1f\x7f@:/\\]/.test(value) ? value : undefined;
}
function matches(left: HubQuotaAccount, right: HubQuotaAccount): boolean {
  const email = left.email?.trim().toLowerCase();
  const plan = left.plan?.trim().toLowerCase();
  const reset = left.quota?.weeklyResetAt;
  const other = right.quota?.weeklyResetAt;
  return !!email?.includes("@") && !!plan && typeof reset === "number" && reset > 0
    && typeof other === "number" && other > 0 && Math.abs(reset - other) <= 2
    && email === right.email?.trim().toLowerCase() && plan === right.plan?.trim().toLowerCase();
}
function project(provider: Provider, rows: HubQuotaAccount[], config: OcxConfig) {
  if (rows.length > MAX_HUB_QUOTA_ACCOUNTS) throw new Error("Quota unavailable");
  const pool = rows.filter(row => !row.isMain);
  return rows.filter(row => provider !== "openai" || !row.isMain || !pool.some(other => matches(row, other))).map(row => {
    const id = createHmac("sha256", projectionKey).update(provider).update("\0").update(row.id).digest("hex");
    const alias = label(row.alias);
    const common = { id, ...(alias ? { alias } : {}), weeklyPercent: percent(row.quota?.weeklyPercent) };
    if (provider === "anthropic") return { ...common, fiveHourPercent: percent(row.quota?.fiveHourPercent) };
    const plan = label(row.plan);
    const dates = row.resetCreditExpirations;
    const expirations = Array.isArray(dates) && dates.length <= 64
      ? dates.flatMap(value => {
        const date = typeof value === "string" && value.length <= 40 ? Date.parse(value) : NaN;
        return Number.isFinite(date) ? [new Date(date).toISOString()] : [];
      }) : null;
    return { ...common, ...(plan ? { plan } : {}), isMain: row.isMain === true, paused: row.paused === true,
      autoSwitchThreshold: percent(row.autoSwitchThresholdOverride ?? config.autoSwitchThreshold ?? 80), resetCreditExpirations: expirations };
  });
}
function enabled(config: OcxConfig, key: OcxApiKeyEntry, provider: Provider): boolean {
  return !!config.providers[provider] && config.providers[provider]!.disabled !== true
    && (!key.allowedProviders?.length || key.allowedProviders.includes(provider));
}

export async function handleHubQuota(req: Request, config: OcxConfig, readers: HubQuotaReaders = hubQuotaReaders, policy: RequestPolicyView = config): Promise<Response> {
  if (config.runtimeRole !== "hub") return reply({ error: "Not found" }, 404);
  if (req.method !== "GET") return reply({ error: "Method not allowed" }, 405);
  const key = permittedKey(req, config, policy);
  if (key instanceof Response) return key;
  if (!isAllowedRequestOrigin(req, policy)) return reply({ error: "Origin rejected" }, 403);
  if (new URL(req.url).search) return reply({ error: "Query parameters not supported" }, 400);
  const scope = JSON.stringify([key.id, key.allowedProviders, key.allowedModels]);
  const states = providerNames.map(provider => enabled(config, key, provider));
  const sources = providerNames.map(provider => config.providers[provider]);
  const snapshots = await Promise.all(providerNames.map(async (provider, index): Promise<{ enabled: boolean; rows: HubQuotaSnapshot; error?: string }> => {
    if (!states[index]) return { enabled: false, rows: [] };
    let timer: ReturnType<typeof setTimeout> | undefined;
    const controller = new AbortController();
    const signal = AbortSignal.any([req.signal, controller.signal]);
    try {
      const rows = await Promise.race([
        readers[provider](config, signal),
        new Promise<never>((_, reject) => { timer = setTimeout(() => { controller.abort(); reject(new Error("Quota unavailable")); }, 20_000); }),
      ]);
      return { enabled: true, rows };
    } catch { return { enabled: true, rows: [], error: "Quota unavailable" }; }
    finally { clearTimeout(timer); }
  }));
  // No await between this admission recheck and response publication.
  if (config.runtimeRole !== "hub") return reply({ error: "Not found" }, 404);
  const current = permittedKey(req, config, policy);
  if (current instanceof Response) return current;
  if (scope !== JSON.stringify([current.id, current.allowedProviders, current.allowedModels])
    || providerNames.some((provider, index) => states[index] !== enabled(config, current, provider)
      || sources[index] !== config.providers[provider])) return reply({ error: "Quota scope changed" }, 403);
  const results = snapshots.map((snapshot, index) => {
    try {
      if (snapshot.error || snapshot.rows.isCurrent?.() === false) throw new Error("Quota unavailable");
      return { enabled: snapshot.enabled, accounts: project(providerNames[index]!, snapshot.rows, config) };
    } catch { return { enabled: snapshot.enabled, accounts: [], error: "Quota unavailable" }; }
  });
  const body = { schemaVersion: 1, generatedAt: new Date().toISOString(), providers: { openai: results[0], anthropic: results[1] } };
  if (Buffer.byteLength(JSON.stringify(body)) > 256 * 1024) return reply({ error: "Quota unavailable" }, 503);
  const active = results.filter(result => result.enabled);
  return reply(body, active.length > 0 && active.every(result => result.error) ? 503 : 200);
}
