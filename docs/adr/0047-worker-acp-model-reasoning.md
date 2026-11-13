# ADR 0047: worker ACP model catalog の reasoning

- Status: superseded in part by [0048](0048-session-resume-feasibility-config-digest.md) (resume digest), [0052](0052-acp-model-injection-by-preset.md) (worker model / reasoning routing), and [0062](0062-worker-acp-model-tags.md) (tag vocabulary and fallback)
- Date: 2026-11-05
- Related: [ADR 0045](0045-worker-acp-model-tags.md), [ADR 0042](0042-explicit-config-replaces-user-layer.md), [Issue #616](https://github.com/otolab/agents-ensemble/issues/616), [Issue #622](https://github.com/otolab/agents-ensemble/issues/622)

## Context

ADR 0045 の model catalog は model ID だけを指定する。推論の深さも環境や tier ごとに変えたいが、profile に provider 固有の設定を置くと環境間で共有しにくい。preset ごとの受け渡し経路と resume 時の整合性も異なる。

## Decision

- `acp.models` の値に従来の文字列に加え `{ model, reasoning? }` を認める。tag から catalog を解決する仕組みなど、ADR 0045 の他の判断は引き継ぐ。`reasoning` は空でない文字列とし、model が対応する値の判断は adapter 側に委ねる。
- user → project の deep merge は構造化エントリの属性にも適用する。文字列の下位層に構造化エントリを重ねる場合は、下位層の文字列を `model` として引き継ぐ。上位層の文字列はエントリ全体を置き換える。merge 後に `model` がない構造化エントリはエラーとする。変更されない文字列 shorthand は変換せず、従来の config digest を保つ。
- `codex` は `CODEX_CONFIG` JSON の `model` と、指定時のみ `model_reasoning_effort` を上書きし、他のキーを保持する。前者は [codex-acp 2.3.0](https://github.com/agentclientprotocol/codex-acp/blob/v2.3.0/README.md#runtime-options) が session config として扱い、後者は [Codex 設定](https://developers.openai.com/codex/config-reference/)のキーである。対応 effort は model と client に依存するため、ensemble は固定の一覧で検証しない。
- `cursor` / `claude` では reasoning の注入を未実装とし、指定された worker を起動前に拒否する。Cursor CLI の bracket 指定は `--help` と[上流の報告](https://forum.cursor.com/t/cursor-cli-agent-model-ignores-reasoning-thinking-level-suffix/159748)が食い違う。[Claude ACP 0.70.0](https://github.com/agentclientprotocol/claude-agent-acp/blob/v0.70.0/src/acp-agent.ts) は model が公開する effort 候補を `session/set_config_option` で設定できる一方、metadata を SDK に渡した後に既存設定から effort を再適用する経路もある。metadata の単純な追加だけでは指定値の適用を保証できない。`pi` / `custom` は従来どおり model 注入自体を拒否する。
- reasoning の変更は現在の config digest で検出する。Codex は spawn env 内の `CODEX_CONFIG` に reasoning を含めるため、worker fingerprint の env digest でも検出できる。新しい fingerprint フィールドは設けず、旧 fingerprint の欠落フィールドを許容する互換規則も維持する。[Issue #616](https://github.com/otolab/agents-ensemble/issues/616) で digest の対象を絞る際も、`acp.models` と spawn env の照合は resume に必要なものとして扱う。

## Consequences

- profile を変えずに、同じ model の reasoning を tier ごとに指定できる。文字列 shorthand はそのまま使える。
- Codex 以外で選択された catalog エントリに reasoning があると、明示的に失敗する。各 adapter の適用経路と resume 時の照合を検証できた場合に、対応を拡張できる。
- catalog の書式を文字列から構造化エントリに変えるだけでも config digest は変わる。session を引き継ぐには設定を変更せず、変更後は新しい session を開始する。
