# ADR 0006: conductor は `mode: agent`

- Status: accepted
- Date: 2026-08-08
- Supersedes: [ADR 0003](0003-conductor-plan-mode.md) の実装方針（[ADR 0005](0005-conductor-is-not-plan-mode.md) と整合）

## Context

[ADR 0005](0005-conductor-is-not-plan-mode.md) で、conductor（役割）と plan mode（SDK オプション）を分離した。plan mode は「プラン更新」が自然な出口になり、スモーク e2e の終了条件と噛み合わない一方、**plan としての挙動自体は妥当**だった。

conductor の振る舞いの正本は PromptModule と profile materials に置ける。`mode: agent` でも system prompt で指揮専任を書ける。

## Decision

`packages/core/src/conductor/conductor-agent.ts` で **`mode: 'agent'`** とする。

演奏しないことの担保は主に以下:

- `conductor-system-module` / materials（プロンプト正本）
- `customTools`: `ask_human` のみ
- worker は `WorkerSession` で別プロセス起動（conductor は実装しない）

built-in ツールの `tools` / `disallowedTools` 制限は **本 ADR では未設定**。必要なら別 ADR。

## Consequences

- 良い: materials の終了条件（例: `conductor-ok`）に従いやすい。plan への同一視を避けられる
- 悪い: agent は標準ツールを持ちうる。プロンプトだけでは編集に寄るリスクが plan より高い
- フォロー: e2e `issue.e2e` を再実行。編集ツール使用が見られたら `disallowedTools` を ADR で追加
