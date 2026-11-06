import { expect, test } from "bun:test";
import { modelsSettingsSummary } from "../src/pages/models-settings-summary";
import { autoReviewModelOptions } from "../src/pages/models-shared";
import type { TFn } from "../src/i18n/shared";

/**
 * The Models settings panel folds the global auto-review override. Two properties matter:
 * the dropdown offers both native and routed rows,
 * and the summary keeps an enabled control visible, including its pending model state.
 */
const t = ((key: string) => key) as unknown as TFn;

const base = {
  multiAgentMode: "v1" as const,
  shadowEnabled: true,
  shadowModel: "xai/grok-4.5",
  windowOn: false,
  windowValue: 350_000,
  pickerMode: "most-used",
  newModelsOff: false,
  aliasesOn: false,
};


test("summary names the auto-review override only while it is on", () => {
  expect(modelsSettingsSummary(t, base).some(item => item.id === "auto-review")).toBe(false);
  const on = modelsSettingsSummary(t, {
    ...base,
    autoReviewEnabled: true,
    autoReviewModel: "9router/ocg-muse-spark-1.3-contributor",
  });
  expect(on.find(item => item.id === "auto-review")).toEqual({
    id: "auto-review",
    label: "models.autoReviewOverride",
    value: "9router/ocg-muse-spark-1.3-contributor",
  });
});

test("an enabled override with no model reads as pending instead of vanishing", () => {
  const pending = modelsSettingsSummary(t, { ...base, autoReviewEnabled: true, autoReviewModel: "" });
  expect(pending.find(item => item.id === "auto-review")).toEqual({
    id: "auto-review",
    label: "models.autoReviewOverride",
    value: "models.autoReviewPending",
  });
});

test("the override dropdown offers native GPT and routed models", () => {
  const visible = [
    { value: "gpt-5.6-sol", label: "GPT-5.6-Sol" },
    { value: "9router/ocg-muse-spark-1.3-contributor", label: "muse-spark" },
  ];
  expect(autoReviewModelOptions(visible).map(option => option.value))
    .toEqual(["gpt-5.6-sol", "9router/ocg-muse-spark-1.3-contributor"]);
  // A value saved by hand in config.json must stay selectable, or the row would read as empty.
  expect(autoReviewModelOptions(visible, "gpt-5.6-sol").map(option => option.value).sort())
    .toEqual(["9router/ocg-muse-spark-1.3-contributor", "gpt-5.6-sol"]);
});

test("saved missing selectors remain selectable and effort stays visible when folded", () => {
  expect(autoReviewModelOptions([], "gpt-6-luna")).toEqual([{ value: "gpt-6-luna", label: "gpt-6-luna" }]);
  expect(modelsSettingsSummary(t, { ...base, autoReviewEnabled: true, autoReviewModel: "gpt-6-luna", autoReviewEffort: "high" }))
    .toContainEqual({ id: "auto-review-effort", label: "models.autoReviewEffort", value: "high" });
});
