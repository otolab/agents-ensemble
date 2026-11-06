# ADR 0049: worker ACP の model / reasoning 注入を preset ごとに扱う

- Status: superseded by [0051](0051-cursor-acp-runtime-verification.md)（Cursor の runtime 制約のみ。その他の preset は継続）
- Date: 2026-11-05
- Related: [ADR 0019](0019-worker-acp-cli-presets.md), [ADR 0045](0045-worker-acp-model-tags.md), [ADR 0047](0047-worker-acp-model-reasoning.md), [Issue #630](https://github.com/otolab/agents-ensemble/issues/630)

## Context

ADR 0047 で `acp.models` に `model` と任意の `reasoning` を持たせたが、model / reasoning の受け渡し経路は preset ごとに異なる。経路がない preset へ値を黙って渡さないことに加え、session 作成後に adapter が実際に選んだ値を確かめる必要がある。

Cursor の CLI が model ID の reasoning suffix を無視する報告（[forum #159748](https://forum.cursor.com/t/cursor-cli-agent-model-ignores-reasoning-thinking-level-suffix/159748)）に対し、Cursor の担当者は後日、最新 CLI では適用されるはずだと案内した。一方、ACP で model variant が意図せず Fast に切り替わる別報告では、担当者が `parameterizedModelPicker` capability と `effort` / `fast` option を使う手順を示し、報告者が認証済みの直接 ACP 接続で確認した（[forum #174835](https://forum.cursor.com/t/cursor-cli-acp-reports-grok-4-6-fast-despite-explicitly-selecting-the-listed-non-fast-model/174835)）。後者は ACP 上で session option の現在値まで確認する経路を示している。

各 upstream adapter には、session config option を返す ACP v1 の仕組みがある（[ACP v1 仕様](https://agentclientprotocol.com/protocol/v1/session-config-options)）。ただし option ID、値、model ごとの対応状況は共通ではない。Codex は `CODEX_CONFIG` と `MODEL_PROVIDER` を別経路で受け取り、Pi は RPC setter の成功応答だけでは thinking level の反映を判断できない場合がある。

## Decision

| preset | model の渡し方 | reasoning の渡し方 | 制約・非対応 |
|--------|----------------|--------------------|--------------|
| `cursor` | `agent --model <id> acp`。model mapping がある場合は `initialize.clientCapabilities._meta.parameterizedModelPicker: true` も送る | session 作成・load 後に `effort` option を設定 | CLI が受け付ける model ID を使う。Fast / non-Fast は model ID 側で選び、独立した catalog field は設けない。ACP が `effort` と値を広告しない場合は失敗 |
| `claude` | `session/new` / `session/load` の Claude settings metadata に加え、session 後に `model` option を設定 | model 設定後に `effort` option を設定 | adapter が選んだ model / effort を読み戻して確認 |
| `codex` | 既存 `CODEX_CONFIG` JSON を保ちながら `model` を上書き | 指定時のみ同じ JSON の `model_reasoning_effort` を上書き | `MODEL_PROVIDER` は Codex の独立した provider 指定として優先。`CODEX_CONFIG.model_provider` の既存値は保持する |
| `pi` | session の `model` option を設定。値は `provider/model-id` | session の `thought_level` option を設定 | adapter が広告する値に限る。Pi が別の現在値を返した場合は失敗 |
| `custom` | 共通注入経路なし | 共通注入経路なし | command の名前から互換性を推測せず、catalog に解決された tag は spawn 前に拒否する。`acp.env` は引き続き渡す |

`claude` / `cursor` / `pi` の option は session の作成・load 後、最初の prompt より前に適用する。設定対象の option と候補値が広告されていることを確かめ、setter 応答の `currentValue` が要求値と一致した場合だけ attach を続ける。option 不在、候補不一致、setter error、読み戻し値の不一致は attach error とする。resume 時も同じ検証を行い、設定の不一致を新しい session の作成で覆い隠さない。

Codex の既存 precedence は変えない。`codex-acp` 2.3.0 は `MODEL_PROVIDER` を `CodexAcpClient` に別途渡し、provider 解決では `CODEX_CONFIG.model_provider` より優先する（[起動処理](https://github.com/agentclientprotocol/codex-acp/blob/v2.3.0/src/index.ts)、[provider 解決](https://github.com/agentclientprotocol/codex-acp/blob/v2.3.0/src/CodexAcpClient.ts)）。catalog による `CODEX_CONFIG` merge とその env digest は維持する。継承値の変更も検出できるよう、effective `MODEL_PROVIDER` は値を保存せず、未設定状態を含めて専用 digest にする。

resume metadata には catalog の `model` / `reasoning` と Codex の `MODEL_PROVIDER` digest を残すが、ADR 0048 / Issue #616 に従い新しい `resume-feasibility` sidecar の拒否条件にはしない。scheme 省略 / `full` の旧 sidecar は保存済み full config digest の従来動作を維持する。

## Consequences

- model / reasoning の語彙を preset 間で共通化しない。各 adapter が広告する候補を使い、指定値が実際に選ばれたことを session response で確かめる。
- Pi ACP 0.0.33 は `model` / `thought_level` の session config option を実装している（[adapter source](https://github.com/svkozak/pi-acp/blob/v0.0.33/src/acp/agent.ts)）。Pi issue #9768（0.85.1）は setter の成功後も `get_state` が古い値を返すケースを記録している。投稿では RPC handler が非同期更新を待たずに応答した可能性が挙がり、maintainer は model が指定 level を clamp する場合にも触れている。issue は completed で閉じられたが、harness は読み戻し値が異なる場合に失敗し、適用を確認できない level を成功扱いしない。
- Cursor forum #159748 の CLI suffix 報告には最新 CLI での修正案内があるが、作業環境では `agent acp` の認証付き session を再現できていない。CLI は `2026.11.05-86047df` で、`agent acp --help` までは確認した。実接続は `cursor_login` による認証と利用可能な model が必要なため、この作業では実施していない。ACP 経路は forum #174835 の担当者案内と投稿者による直接接続の確認を根拠に採用し、ローカル検証済みとは扱わない。別 option の `fast` はこの catalog では独立設定できないため、Cursor が選んだ model variant に委ねる。
- protocol fake を使う attach / resume テストは、実 model 呼び出しなしで harness の注入・読み戻し検証を確認する。上流 adapter と認証済み provider を使う実行確認とは区別する。
- custom command は自由形式のため、Cursor 互換などの部分的な推測を導入しない。独自の model 設定は command 側の `acp.env` 契約で管理する。
