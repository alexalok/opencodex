import { describe, expect, test } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import upstreamModelsSnapshot from "../../src/codex/data/upstream-models.json";
import {
  accountBoundNativeOpenAiSlugsBySelector,
  effectiveSubagentRoster,
  filterSupportedNativeSlugs,
  loadBundledCodexCatalog,
  observedAccountBoundNativeEntries,
  resetCatalogRuntimeStateForTests,
  upstreamNativeEntry,
} from "../../src/codex/catalog";
import {
  CANONICAL_NATIVE_CATALOG_CONTENT_POLICY,
  mergeCatalogEntriesFromObservedState,
  syncCatalogModels,
  type ObservedCatalogMergeInput,
} from "../../src/codex/catalog/sync";
import { applyAutoReviewModelOverride, applyConfiguredAutoReviewModelOverride } from "../../src/codex/catalog/auto-review";
import { isUnsupportedOpenAiNativeSlug } from "../../src/codex/catalog/metadata";
import {
  CODEX_AUTO_REVIEW_MODEL,
  CODEX_CONTROL_PLANE_HELPER_MODELS,
  NATIVE_OPENAI_MODELS,
  RETIRED_NATIVE_OPENAI_MODELS,
  SUPPORTED_NATIVE_OPENAI_SLUGS,
} from "../../src/codex/catalog/native-models";
import { captureCatalogAdmissionSnapshot } from "../../src/codex/catalog-admission";
import { convergeCodexCatalog } from "../../src/codex/convergence";
import { resetCodexModelEntitlementCacheForTests } from "../../src/codex/model-entitlements";
import { resetCodexRuntimeResolveCacheForTests } from "../../src/codex/runtime";
import { resolveCodexCatalogSerializationDatabasePath, resolveEffectiveUserIdentity } from "../../src/codex/user-identity";
import { saveConfig } from "../../src/config";
import { SUBAGENT_MODELS_VERSION } from "../../src/config/subagent-models";
import { CODEX_FORWARD_BASE_URL } from "../../src/providers/openai-tiers";
import type { OcxConfig } from "../../src/types";
import { removeTreeWithRetry } from "../helpers/remove-tree";

// Codex reads model_catalog_json as a static catalog. Guardian finds its default reviewer
// (`codex-auto-review` under ChatGPT auth) only if that hidden row is in this file; otherwise it
// falls back to the parent model. These cases pin the restored row and every surface it must avoid.

type Row = Record<string, unknown>;

const PINNED = (upstreamModelsSnapshot as unknown as { models: Row[] }).models
  .find(row => row.slug === CODEX_AUTO_REVIEW_MODEL)!;

/** Shape Codex 0.159 writes into models_cache.json: no base_instructions, auto_review policy present. */
function liveHelperRow(policy = "fixture auto-review policy"): Row {
  const { base_instructions: _base, minimal_client_version: _floor, ...rest } = structuredClone(PINNED);
  return {
    ...rest,
    comp_hash: "3000",
    multi_agent_version: "v1",
    model_messages: {
      ...(PINNED.model_messages as Row),
      auto_review: { policy, policy_template: "{tenant_policy_config}" },
    },
  };
}

function nativeRow(slug: string, priority = 1): Row {
  return {
    slug,
    display_name: `Fixture ${slug}`,
    description: "Native GPT model",
    priority,
    visibility: "list",
    base_instructions: "You are Codex, a coding agent based on GPT-5.",
    model_messages: { instructions_template: "You are Codex, a coding agent based on GPT-5." },
    shell_type: "unified_exec",
    comp_hash: "native",
    supported_in_api: true,
    auto_review_model_override: null,
    supported_reasoning_levels: [
      { effort: "low", description: "native low" },
      { effort: "medium", description: "native medium" },
    ],
  };
}

function merge(
  input: Pick<ObservedCatalogMergeInput, "catalogModels"> & Partial<ObservedCatalogMergeInput>,
): Row[] {
  return mergeCatalogEntriesFromObservedState({
    baselineCatalogModels: [],
    routedEntries: [],
    baseline: new Map(),
    featured: [],
    wsEnabled: false,
    template: nativeRow("gpt-5.6-sol"),
    disabledModels: new Set(),
    selectedModelsByProvider: new Map(),
    gatheredProviderNames: new Set(),
    degradedProviderNames: new Set(),
    legacyCustomModelSlugs: new Set(),
    multiAgentMode: "default",
    multiAgentV2Enabled: false,
    exactComboSlugs: new Set(),
    hasPhysicalComboProvider: false,
    includeNativeOpenAi: true,
    accountBoundEntries: [],
    policy: { ...CANONICAL_NATIVE_CATALOG_CONTENT_POLICY, warningPolicy: "suppress" },
    ...input,
  });
}

const helpersIn = (rows: readonly Row[]) => rows.filter(row => row.slug === CODEX_AUTO_REVIEW_MODEL);
const policyOf = (row: Row | undefined) =>
  ((row?.model_messages as Row | undefined)?.auto_review as Row | undefined)?.policy;

describe("hidden codex-auto-review helper row", () => {
  test("keeps the Codex-observed row hidden with its upstream metadata, untouched by picker policy", () => {
    const out = merge({
      catalogModels: [nativeRow("gpt-5.6-sol")],
      controlPlaneHelperSources: [[liveHelperRow()]],
      featured: ["gpt-5.6-sol"],
      modelPickerOrder: ["gpt-5.6-sol"],
      multiAgentMode: "v2",
    });
    const helpers = helpersIn(out);
    expect(helpers).toHaveLength(1);
    const helper = helpers[0]!;
    expect(helper).toMatchObject({
      visibility: "hide",
      display_name: "Codex Auto Review",
      supported_in_api: true,
      priority: 43,
      // The v2 pass stamps every picker row; the reviewer keeps upstream's own pin.
      multi_agent_version: "v1",
      auto_review_model_override: null,
    });
    expect(policyOf(helper)).toBe("fixture auto-review policy");
    // No mock max/ultra rungs: the ladder is upstream's.
    expect((helper.supported_reasoning_levels as Row[]).map(level => level.effort))
      .toEqual(["low", "medium", "high", "xhigh"]);
    expect(Object.keys(helper).filter(key => key.startsWith("opencodex_"))).toEqual([]);
    // The picker default stays a listed native, never the reviewer.
    expect(out.find(row => row.visibility === "list")?.slug).toBe("gpt-5.6-sol");
  });

  test("prefers the models cache, then the installed catalog, then the file being overwritten", () => {
    const disk = { ...liveHelperRow("disk"), visibility: "list" };
    const pick = (sources: Row[][]) => policyOf(helpersIn(merge({
      catalogModels: [nativeRow("gpt-5.6-sol"), disk],
      controlPlaneHelperSources: sources,
    }))[0]);
    expect(pick([[liveHelperRow("cache")], [liveHelperRow("bundled")]])).toBe("cache");
    expect(pick([[], [liveHelperRow("bundled")]])).toBe("bundled");
    expect(pick([])).toBe("disk");
  });

  test("backfills from the pinned upstream snapshot when no source carries a genuine row", () => {
    const stub = { slug: CODEX_AUTO_REVIEW_MODEL, visibility: "list" };
    const routedLookalike = { ...liveHelperRow("routed"), description: "Routed via opencodex → x (y)." };
    const helpers = helpersIn(merge({
      catalogModels: [nativeRow("gpt-5.6-sol"), stub],
      controlPlaneHelperSources: [[routedLookalike]],
    }));
    expect(helpers).toHaveLength(1);
    expect(helpers[0]).toMatchObject({
      visibility: "hide",
      display_name: PINNED.display_name,
      base_instructions: PINNED.base_instructions,
      priority: PINNED.priority,
    });
    expect(helpers[0]).not.toHaveProperty("minimal_client_version");
  });

  test("is omitted with the other bare natives when no canonical OpenAI route exists", () => {
    expect(helpersIn(merge({
      catalogModels: [nativeRow("gpt-5.6-sol"), liveHelperRow()],
      controlPlaneHelperSources: [[liveHelperRow()]],
      includeNativeOpenAi: false,
    }))).toEqual([]);
  });

  test("never reaches picker, subagent roster, native-slug or account-selector surfaces", () => {
    const out = merge({
      catalogModels: [nativeRow("gpt-5.6-sol")],
      controlPlaneHelperSources: [[liveHelperRow()]],
      accountSelectors: ["desktop"],
    });
    expect(filterSupportedNativeSlugs(out)).not.toContain(CODEX_AUTO_REVIEW_MODEL);
    for (const surface of ["v1", "v2"] as const) {
      const roster = effectiveSubagentRoster([CODEX_AUTO_REVIEW_MODEL], surface, out);
      expect(roster.candidates.map(candidate => candidate.model)).not.toContain(CODEX_AUTO_REVIEW_MODEL);
      expect(roster.excluded).toEqual([{
        configured: CODEX_AUTO_REVIEW_MODEL, catalogModel: CODEX_AUTO_REVIEW_MODEL, reason: "picker_hidden",
      }]);
    }
    expect(out.some(row => typeof row.slug === "string" && row.slug.endsWith(`/${CODEX_AUTO_REVIEW_MODEL}`)))
      .toBe(false);
    // Even a listed, API-supported observation is not an account-native candidate.
    const observed = { ...liveHelperRow(), visibility: "list" };
    const selectorConfig = {
      codexAccounts: [{ id: "stored-side-account", isMain: false }],
      codexAccountNamespaces: { desktop: "@main", side: "stored-side-account" },
    } as unknown as Parameters<typeof accountBoundNativeOpenAiSlugsBySelector>[0];
    for (const slugs of accountBoundNativeOpenAiSlugsBySelector(selectorConfig, [observed]).values()) {
      expect(slugs).not.toContain(CODEX_AUTO_REVIEW_MODEL);
    }
    expect(observedAccountBoundNativeEntries([observed])).toEqual([]);
    expect(SUPPORTED_NATIVE_OPENAI_SLUGS.has(CODEX_AUTO_REVIEW_MODEL)).toBe(false);
    expect(NATIVE_OPENAI_MODELS).not.toContain(CODEX_AUTO_REVIEW_MODEL);
    // The sync-replacement authority stays reserved for the GPT-5.6 family and Astra.
    expect(upstreamNativeEntry(CODEX_AUTO_REVIEW_MODEL)).toBeNull();
  });

  test("stays exactly one byte-stable row when each merge re-reads the previous output", () => {
    const first = merge({
      catalogModels: [nativeRow("gpt-5.6-sol"), liveHelperRow("a"), { ...liveHelperRow("b"), visibility: "list" }],
      controlPlaneHelperSources: [[liveHelperRow("cache")]],
    });
    expect(helpersIn(first)).toHaveLength(1);
    const second = merge({ catalogModels: first, controlPlaneHelperSources: [first] });
    const third = merge({ catalogModels: second, controlPlaneHelperSources: [second] });
    expect(second).toEqual(first);
    expect(third).toEqual(first);
    expect(policyOf(helpersIn(third)[0])).toBe("cache");
  });

  test("root auto_review_model stamps parent rows only, and codex-auto-review now resolves as a target", () => {
    const rows = () => [
      ...merge({ catalogModels: [nativeRow("gpt-5.6-sol")], controlPlaneHelperSources: [[liveHelperRow()]] }),
      {
        slug: "anthropic/claude-x",
        description: "Routed via opencodex → anthropic (claude-x).",
        visibility: "list",
        auto_review_model_override: null,
      },
    ];
    const bySlug = (models: Row[], slug: string) => models.find(row => row.slug === slug)!;

    const stamped = rows();
    expect(applyAutoReviewModelOverride(stamped, "anthropic/claude-x")).toBe("applied");
    expect(bySlug(stamped, "gpt-5.6-sol").auto_review_model_override).toBe("anthropic/claude-x");
    expect(bySlug(stamped, "anthropic/claude-x").auto_review_model_override).toBe("anthropic/claude-x");
    const helper = bySlug(stamped, CODEX_AUTO_REVIEW_MODEL);
    expect(helper.auto_review_model_override).toBeNull();
    expect(helper).not.toHaveProperty("opencodex_auto_review_root");
    expect(applyAutoReviewModelOverride(stamped, null)).toBe("absent");
    expect(bySlug(stamped, "gpt-5.6-sol").auto_review_model_override).toBeNull();

    // Before the row was restored this selector was "unresolved" and silently ignored.
    const toHelper = rows();
    expect(applyAutoReviewModelOverride(toHelper, CODEX_AUTO_REVIEW_MODEL)).toBe("applied");
    expect(bySlug(toHelper, "gpt-5.6-sol").auto_review_model_override).toBe(CODEX_AUTO_REVIEW_MODEL);
    expect(bySlug(toHelper, CODEX_AUTO_REVIEW_MODEL).auto_review_model_override).toBeNull();

    const provider = rows();
    // Provider stamps land on routed rows; the root selector stamps the remaining parent rows only.
    expect(applyConfiguredAutoReviewModelOverride(provider, "gpt-5.6-sol", {
      providers: { anthropic: { autoReviewModel: "anthropic/claude-x" } },
    } as unknown as Pick<OcxConfig, "providers">)).toBe("applied");
    expect(bySlug(provider, "anthropic/claude-x").auto_review_model_override).toBe("anthropic/claude-x");
    expect(bySlug(provider, "gpt-5.6-sol").auto_review_model_override).toBe("gpt-5.6-sol");
    expect(bySlug(provider, CODEX_AUTO_REVIEW_MODEL).auto_review_model_override).toBeNull();
  });

  test("retired natives cannot ride the helper exemption back", () => {
    for (const slug of CODEX_CONTROL_PLANE_HELPER_MODELS) {
      expect(RETIRED_NATIVE_OPENAI_MODELS.has(slug)).toBe(false);
      expect(SUPPORTED_NATIVE_OPENAI_SLUGS.has(slug)).toBe(false);
      expect(isUnsupportedOpenAiNativeSlug(slug)).toBe(false);
    }
    // The exemption is exact: the codex- prefix rule still drops every other legacy id.
    expect(isUnsupportedOpenAiNativeSlug("codex-mini-latest")).toBe(true);
    for (const slug of RETIRED_NATIVE_OPENAI_MODELS) expect(isUnsupportedOpenAiNativeSlug(slug)).toBe(true);
    const retiredRows = [...RETIRED_NATIVE_OPENAI_MODELS].map(slug => ({ ...liveHelperRow(), slug, visibility: "list" }));
    const out = merge({
      catalogModels: [nativeRow("gpt-5.6-sol"), ...retiredRows, nativeRow("codex-mini-latest")],
      controlPlaneHelperSources: [retiredRows],
    });
    const slugs = out.map(row => row.slug);
    for (const slug of RETIRED_NATIVE_OPENAI_MODELS) expect(slugs).not.toContain(slug);
    expect(slugs).not.toContain("codex-mini-latest");
    expect(helpersIn(out)).toHaveLength(1);
  });
});

// Both production writers, from a models cache that carries the row and from a home without one.
describe("catalog writers restore the hidden reviewer row", () => {
  test.each([
    ["retained", "models-cache"],
    ["retained", "pinned"],
    ["convergence", "models-cache"],
    ["convergence", "pinned"],
  ] as const)("%s writer from %s source", async (writer, source) => {
    const envKeys = ["CODEX_HOME", "OPENCODEX_HOME", "CODEX_CLI_PATH"] as const;
    const previousEnv = envKeys.map(key => process.env[key]);
    const previousFetch = globalThis.fetch;
    const root = realpathSync.native(mkdtempSync(join(tmpdir(), "ocx-auto-review-helper-")));
    const codexHome = join(root, "codex");
    const catalogPath = join(codexHome, "custom-catalog.json");
    const configToml = join(codexHome, "config.toml");
    try {
      mkdirSync(codexHome);
      mkdirSync(join(root, "ocx"));
      process.env.CODEX_HOME = codexHome;
      process.env.OPENCODEX_HOME = join(root, "ocx");
      writeFileSync(configToml, 'model_catalog_json = "custom-catalog.json"\n');
      // The installed runtime's bundled catalog predates the helper, as older Codex builds do.
      const catalog = { models: [nativeRow("gpt-5.6-sol")] };
      const script = join(root, "fixture-codex.js");
      writeFileSync(script, [
        'if (process.argv.includes("--version")) console.log("codex-cli 0.145.0");',
        `else process.stdout.write(${JSON.stringify(JSON.stringify(catalog))});`,
      ].join("\n"));
      if (process.platform === "win32") {
        process.env.CODEX_CLI_PATH = join(root, "fixture-codex.cmd");
        writeFileSync(process.env.CODEX_CLI_PATH, `@echo off\r\n"${process.execPath}" "${script}" %*\r\n`);
      } else {
        process.env.CODEX_CLI_PATH = join(root, "fixture-codex");
        const quote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`;
        writeFileSync(process.env.CODEX_CLI_PATH, `#!/bin/sh\nexec ${quote(process.execPath)} ${quote(script)} "$@"\n`);
        chmodSync(process.env.CODEX_CLI_PATH, 0o755);
      }
      resetCatalogRuntimeStateForTests();
      resetCodexRuntimeResolveCacheForTests();
      resetCodexModelEntitlementCacheForTests();
      expect(loadBundledCodexCatalog()?.models?.[0]?.slug).toBe("gpt-5.6-sol");
      writeFileSync(catalogPath, JSON.stringify(catalog));
      if (source === "models-cache") {
        writeFileSync(join(codexHome, "models_cache.json"), JSON.stringify({
          fetched_at: "2026-10-01T03:30:01Z", client_version: "0.159.2", models: [liveHelperRow("from cache")],
        }));
      }
      globalThis.fetch = (async () => {
        throw new Error("auto-review helper writer fixture must not make a network request");
      }) as unknown as typeof fetch;
      const config: OcxConfig = {
        port: 10100, defaultProvider: "openai",
        subagentModels: [], subagentModelsVersion: SUBAGENT_MODELS_VERSION,
        providers: {
          openai: { adapter: "openai-responses", baseUrl: CODEX_FORWARD_BASE_URL, authMode: "forward" },
        },
      };
      saveConfig(config);
      const write = async (): Promise<Row[]> => {
        if (writer === "convergence") {
          const result = await convergeCodexCatalog(captureCatalogAdmissionSnapshot(config), {
            action: "converge", scope: "catalog", reason: "management-mutation", mode: "explicit", deadlineMs: 5_000,
          });
          expect(result.catalogRefresh.status).toBe("committed");
        } else {
          const result = await syncCatalogModels(config);
          expect(result.path).toBe(catalogPath);
        }
        return (JSON.parse(readFileSync(catalogPath, "utf8")) as { models: Row[] }).models;
      };

      const first = await write();
      const helpers = helpersIn(first);
      expect(helpers).toHaveLength(1);
      expect(helpers[0]).toMatchObject({ visibility: "hide", display_name: "Codex Auto Review" });
      if (source === "models-cache") expect(policyOf(helpers[0])).toBe("from cache");
      else expect(helpers[0]!.base_instructions).toBe(PINNED.base_instructions);
      const firstBytes = readFileSync(catalogPath, "utf8");
      await write();
      expect(readFileSync(catalogPath, "utf8")).toBe(firstBytes);

      // Root auto_review_model keeps stamping parent rows through the real writer.
      writeFileSync(configToml, 'model_catalog_json = "custom-catalog.json"\nauto_review_model = "codex-auto-review"\n');
      const stamped = await write();
      expect(stamped.find(row => row.slug === "gpt-5.6-sol")?.auto_review_model_override).toBe(CODEX_AUTO_REVIEW_MODEL);
      expect(helpersIn(stamped).map(row => row.auto_review_model_override)).toEqual([null]);
      writeFileSync(configToml, 'model_catalog_json = "custom-catalog.json"\n');
      const cleared = await write();
      expect(cleared.find(row => row.slug === "gpt-5.6-sol")?.auto_review_model_override).toBeNull();
      expect(helpersIn(cleared)).toHaveLength(1);
    } finally {
      try {
        const database = resolveCodexCatalogSerializationDatabasePath(resolveEffectiveUserIdentity(), codexHome);
        for (const suffix of ["", "-journal", "-wal", "-shm"]) rmSync(`${database}${suffix}`, { force: true });
      } finally {
        globalThis.fetch = previousFetch;
        envKeys.forEach((key, index) => {
          const value = previousEnv[index];
          if (value === undefined) delete process.env[key];
          else process.env[key] = value;
        });
        resetCatalogRuntimeStateForTests();
        resetCodexRuntimeResolveCacheForTests();
        resetCodexModelEntitlementCacheForTests();
        removeTreeWithRetry(root);
      }
    }
  }, 30_000);
});
