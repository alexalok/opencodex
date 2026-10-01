import upstreamModelsSnapshot from "../data/upstream-models.json";
import type { RawEntry } from "./parsing";
import { CODEX_CONTROL_PLANE_HELPER_MODELS } from "./native-models";

/** True for a bare hidden Codex control-plane helper id such as `codex-auto-review`. */
export function isCodexControlPlaneHelperSlug(slug: unknown): slug is string {
  return typeof slug === "string" && CODEX_CONTROL_PLANE_HELPER_MODELS.has(slug);
}

/**
 * Shape gate for a helper row read from a Codex-owned source. Like `hasNativeCatalogRowShape` this
 * is plausibility, not attestation: the sources are user-owned files Codex writes. It rejects rows
 * OpenCodex itself synthesized (routed/combo/custom/account projections) and rows with no reasoning
 * ladder or prompt material, so a stub can never displace genuine upstream metadata.
 */
function isUpstreamHelperRow(entry: RawEntry, slug: string): boolean {
  const levels = entry.supported_reasoning_levels;
  const messages = entry.model_messages;
  return entry.slug === slug
    && entry.opencodex_catalog_kind === undefined
    && !(typeof entry.description === "string" && entry.description.startsWith("Routed via opencodex → "))
    && Array.isArray(levels)
    && levels.length > 0
    && levels.every(level => typeof level === "object" && level !== null
      && typeof (level as { effort?: unknown }).effort === "string")
    && ((typeof messages === "object" && messages !== null && !Array.isArray(messages))
      || (typeof entry.base_instructions === "string" && entry.base_instructions.length > 0));
}

function pinnedHelperRow(slug: string): RawEntry | undefined {
  const models = (upstreamModelsSnapshot as unknown as { models?: RawEntry[] }).models ?? [];
  const pinned = models.find(entry => entry.slug === slug);
  if (!pinned) return undefined;
  const clone = structuredClone(pinned);
  // Same projection upstreamNativeEntry applies to pinned rows: the pin's floor is not ours to gate.
  delete clone.minimal_client_version;
  return clone;
}

/**
 * One hidden row per helper slug, taken from the first source that carries a genuine upstream row
 * and otherwise from the pinned upstream snapshot. Callers order `sources` by freshness (the
 * Codex models cache, then the installed/bundled catalog, then the file being overwritten, then
 * backups). OpenCodex-private fields are stripped and visibility is forced to `hide` so the row
 * is resolvable by Guardian but never offered by a picker, roster or account projection.
 */
export function resolveCodexControlPlaneHelperEntries(
  sources: readonly (readonly RawEntry[])[],
): RawEntry[] {
  return [...CODEX_CONTROL_PLANE_HELPER_MODELS].flatMap(slug => {
    let selected: RawEntry | undefined;
    for (const source of sources) {
      selected = source.find(entry => entry && typeof entry === "object" && isUpstreamHelperRow(entry, slug));
      if (selected) break;
    }
    const row = selected ? structuredClone(selected) : pinnedHelperRow(slug);
    if (!row) return [];
    for (const key of Object.keys(row)) {
      if (key.startsWith("opencodex_")) delete row[key];
    }
    row.visibility = "hide";
    return [row];
  });
}
