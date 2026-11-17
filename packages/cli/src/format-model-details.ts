import {
  escapeTerminalControlCharacters,
  type PiResolvedModelDetails,
} from '@agents-ensemble/core';

const MODEL_SOURCE_LABELS: Record<PiResolvedModelDetails['modelSource'], string> = {
  'pi-ai': 'Pi 組み込みモデル情報',
  'models.json': 'models.json',
};

const CONTEXT_WINDOW_SOURCE_LABELS: Record<
  PiResolvedModelDetails['contextWindowSource'],
  string
> = {
  'pi-ai': 'Pi 組み込みモデル情報',
  'models.json': 'models.json の model / modelOverride',
  'pi-custom-model-default': 'Pi のカスタムモデル既定値',
  unavailable: '取得できません',
};

export function formatModelDetailsText(details: PiResolvedModelDetails): string {
  const safe = escapeTerminalControlCharacters;
  const contextWindow =
    details.contextWindow === null
      ? '取得できません'
      : `${details.contextWindow} tokens`;
  const maxTokens =
    details.maxTokens === null ? '取得できません' : `${details.maxTokens} tokens`;

  return [
    `provider: ${safe(details.provider)}`,
    `id: ${safe(details.id)}`,
    `name: ${safe(details.name)}`,
    `contextWindow: ${contextWindow} (${CONTEXT_WINDOW_SOURCE_LABELS[details.contextWindowSource]})`,
    `maxTokens: ${maxTokens}`,
    `model source: ${MODEL_SOURCE_LABELS[details.modelSource]}`,
    `selection source: model=${safe(details.selection.model)}; provider=${safe(details.selection.provider)}`,
    '注: 表示値は Pi の組み込み情報またはローカル定義です。provider 側の上限を検証した値ではありません。',
  ].join('\n');
}

export function formatModelDetailsJson(details: PiResolvedModelDetails): string {
  return JSON.stringify(details, null, 2);
}
