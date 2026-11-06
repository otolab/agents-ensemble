# ADR 0049: conductor reasoning を backend ごとに適用する

- Status: superseded by [0051](0051-conductor-reasoning-resume-digest.md) (resume digest policy only)
- Date: 2026-11-05
- Related: [ADR 0047](0047-worker-acp-model-reasoning.md), [ADR 0025](0025-conductor-agent-backend-sdk-and-pi.md), [Issue #629](https://github.com/otolab/agents-ensemble/issues/629)

## Context

`conductor.model` は CLI / env / merged config から解決できるが、conductor の reasoning は設定できなかった。worker の `acp.models.*.reasoning` と違い、Pi conductor と Cursor SDK conductor では指定方法も値の語彙も異なる。

依存中の Pi 1.2.0 は `createAgentSession` の `thinkingLevel` を受け取る。ただし Pi SDK は model が未対応の level を clamp してから使うため、明示した値が別の値へ置き換わる可能性がある。Pi model の `thinkingLevelMap` は provider ごとの変換を表現する。

Pi の model metadata が level を受け付けても、provider adapter がその値を正しい wire format で送るとは限らない。Pi 1.2.0 の Google adapter は Gemini 4 を level-based thinking として識別せず `thinkingBudget` を選ぶ経路があり、Google API がその request を拒否する既知の問題がある。これは `google-generative-ai` と `google-vertex` が共用する adapter に関わる（[Pi 1.2.0 Google adapter](https://github.com/earendil-works/pi/blob/v1.2.0/packages/ai/src/api/google-shared.ts#L1316-L1345)、[upstream issue #10973](https://github.com/earendil-works/pi/issues/10973)）。

Cursor SDK 1.0.27 は `ModelSelection.params` と `Cursor.models.list()` を提供するが、reasoning parameter の ID / 値は model と account によって異なり、共通名を定めていない。未対応値を SDK に渡して無視されないよう、利用可能な model catalog から適用先を特定する必要がある。

## Decision

- `conductor.reasoning` は空でない文字列とし、固定 enum にはしない。優先順位は `--reasoning` > `CONDUCTOR_REASONING` > merged config。すべて未指定なら値を backend に渡さず、backend の既定を使う。
- Pi は指定値を `createAgentSession({ thinkingLevel })` に渡す。Pi native level の妥当性と、選択した model が `getSupportedThinkingLevels()` でその値に対応することを session manager / transcript を開く前に確認する。Pi 1.2.0 の Google adapter が Gemini 4 を level-based request として扱えないため、`google-generative-ai` / `google-vertex` の Gemini 4 model に明示指定した場合は同じく起動前にエラーにする。その他の provider 固有 request 変換は Pi の `thinkingLevelMap` と provider adapter に委ねる。指定がない場合は `thinkingLevel` を渡さず、Pi `settings.json.defaultThinkingLevel` を有効化しない。
- Cursor は reasoning が指定された場合だけ `Cursor.models.list()` を呼び出す。選択 model は catalog の完全一致 ID を優先し、一致がなければ一意な alias を使う。reasoning / thinking / effort を表すと識別できる parameter の中から、指定値と一致する parameter と値を一意に特定して `ModelSelection.params` に渡す。parameter 定義がない場合は model variant に含まれる同じ種別の parameter 値を参照する。model が catalog にない、値が対応しない、または複数の候補が残る場合は `Agent.create` / `Agent.resume` 前にエラーとする。warning 付き no-op にはしない。
- resume digest は既存どおり merged `EnsembleConfig` 全体を対象とし、`conductor.reasoning` の config 値を照合する。CLI / env override は `conductor.model` と同様 digest の対象外とする。`sessionModels.conductor.configuredReasoning` には解決後の指定値を載せるが、SDK / provider が適用した値の再取得とは扱わない。

API の根拠: [Pi coding-agent 1.2.0 `createAgentSession`](https://github.com/earendil-works/pi/blob/v1.2.0/packages/coding-agent/src/core/sdk.ts)、[Pi AI 1.2.0 model thinking support](https://github.com/earendil-works/pi/blob/v1.2.0/packages/ai/src/models.ts)、[Pi 1.2.0 Google adapter](https://github.com/earendil-works/pi/blob/v1.2.0/packages/ai/src/api/google-shared.ts#L1316-L1345)、[upstream issue #10973](https://github.com/earendil-works/pi/issues/10973)、[Cursor SDK model parameters](https://cursor.com/docs/sdk/typescript#model-parameters)。

## Consequences

- Pi と Cursor の設定値は同じ YAML field から渡すが、受け付ける値と adapter の経路は backend ごとに異なる。値の妥当性は adapter が選択 model / account catalog に照らして判定する。
- 明示値を Pi が clamp したり、Cursor が受け付けずに無視したりするのを避けられる。一方、Cursor catalog で parameter 名や値を reasoning と識別できない model は、実際に内部対応していても設定できず fail fast する。
- Pi の `settings.json.defaultThinkingLevel` は引き続き headless conductor に適用しない。全体設定を読み込むと backend 専用の意図しない設定が漏れるため、明示指定は ensemble の `conductor.reasoning` に分ける。
- Pi の fail-fast は Pi model metadata と既知の Google Gemini 4 互換性問題を検証する。custom provider / model metadata が実際の API 契約と違う場合や、provider adapter の他の不具合までは事前に検出できず、request が失敗する可能性は残る。
- resume 時は config field の変更を検出する。CLI / env override を変更して resume した場合は digest 不一致にならないため、新しい優先値が再適用される。この挙動は既存 `conductor.model` と揃う。
- 終了サマリの `configuredReasoning` は指定値の記録であり、provider が実際に使った内部 effort の証明ではない。
