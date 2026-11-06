# ADR 0050: operator-agent に conductor reasoning を適用する

- Status: superseded by [0051](0051-conductor-reasoning-resume-digest.md) (resume digest policy only)
- Date: 2026-11-05
- Related: [ADR 0031](0031-operator-agent-layer.md), [ADR 0049](0049-conductor-reasoning-backends.md), [Issue #629](https://github.com/otolab/agents-ensemble/issues/629)

## Context

operator-agent は Issue session とは別の会話だが、Phase 1 の契約として `conductor.backend` / `conductor.model` と Pi の backend 設定、認証、merged config を conductor と共有する（[ADR 0031](0031-operator-agent-layer.md)）。`conductor.reasoning` は backend adapter に渡す model 実行設定であり、Issue session 専用とする記述はなかった。一方、最初の実装では Issue 起動経路だけが `CONDUCTOR_REASONING` / config を解決し、operator-agent の `ConductorAgentCreateOptions` へは渡していなかった。

operator-agent 専用の reasoning 設定や CLI override を設けると、同じ backend / model を使う agent の設定が入口ごとに分かれ、Issue だけに限定する根拠のない差が生じる。operator-agent の session は既存どおり backend 固有 agent ID から resume され、起動ごとに model / backend options を factory へ渡す。

## Decision

- `conductor.reasoning` は Issue conductor と operator-agent の両方に適用する。
- `ensemble issue` は `--reasoning` > `CONDUCTOR_REASONING` > merged config の順、operator-agent は `CONDUCTOR_REASONING` > merged config の順で解決する。CLI option は Issue 起動の invocation override として扱う。
- 解決後の値を共通 `ConductorAgentCreateOptions.reasoning` に含め、create / resume で選択された Pi または Cursor factory に渡す。未指定の場合は field 自体を含めず、従来どおり backend の既定に委ねる。
- Pi と Cursor の値検証・適用方法・unsupported model 時の fail-fast は [ADR 0049](0049-conductor-reasoning-backends.md) の契約を共有する。operator-agent に固有の adapter や reasoning namespace は追加しない。

## Consequences

- 同じ `conductor.reasoning` と `CONDUCTOR_REASONING` が Issue session と operator-agent の model 実行を揃える。operator-agent の継続 session も、新しい起動時に解決した値を create / resume factory へ渡す。
- backend が指定値を適用できない場合、operator-agent も Issue session と同じく Pi / Cursor adapter の fail-fast を受ける。Cursor では利用アカウントの catalog に model / parameter / value が見つからない場合に開始・再開できない。
- reasoning を省略した既存 operator-agent session は引き続き `thinkingLevel` / `ModelSelection.params` を明示せず、backend の標準動作を使う。Pi の `settings.json.defaultThinkingLevel` は operator-agent でも新たに読み込まない。
- operator-agent の保存 session state に config digest はなく、reasoning 変更を理由に既存 session を拒否しない。現在の config / env を次の create / resume に適用する。Issue SessionResumeStore の digest は引き続き merged config の reasoning 変更を検出するが、CLI / env override は対象外である。
- operator-agent は Issue session の `sessionModels` summary を出さないため、`configuredReasoning` の表示対象は従来どおり Issue session とする。
