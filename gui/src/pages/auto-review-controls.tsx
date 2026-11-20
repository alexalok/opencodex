import type { TFn, TKey } from "../i18n/shared";
import { Select, Switch } from "../ui";
import type { AutoReviewData } from "./models-shared";
import { InfoHint, SettingsRow } from "./models-settings-panel";

const EFFORTS = ["none", "minimal", "low", "medium", "high", "xhigh", "max", "ultra"] as const;

export function AutoReviewControls({ data, saving, options, save, t }: {
  data: AutoReviewData | null;
  saving: boolean;
  options: { value: string; label: string }[];
  save: (patch: Partial<AutoReviewData>) => Promise<void>;
  t: TFn;
}) {
  const disabled = !data || saving || !data.enabled;
  const efforts = [{ value: "", label: t("models.autoReviewEffortDefault") },
    ...EFFORTS.map(value => ({ value, label: t(`models.reasoningEffort.${value}` as TKey) }))];
  return <>
    <SettingsRow label={t("models.autoReviewOverride")} hint={<InfoHint text={t("models.autoReviewOverrideHint")} />} busy={!data}>
      <Switch on={data?.enabled ?? false} onClick={() => void save({ enabled: !data?.enabled })} disabled={!data || saving} label={t("models.autoReviewOverride")} />
      <div className="models-shadow-model-slot">
        <Select value={data?.model ?? ""} options={options} onChange={model => void save({ model })} disabled={disabled} label={t("models.autoReviewOverride")} />
      </div>
    </SettingsRow>
    <SettingsRow label={t("models.autoReviewEffort")} hint={<InfoHint text={t("models.autoReviewEffortHint")} />}>
      <Select value={data?.reasoningEffort ?? ""} options={efforts} onChange={reasoningEffort => void save({ reasoningEffort })} disabled={disabled} label={t("models.autoReviewEffort")} />
    </SettingsRow>
  </>;
}
