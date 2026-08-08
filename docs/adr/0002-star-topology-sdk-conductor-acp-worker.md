# ADR 0002: スター型 — SDK conductor + ACP worker

- Status: accepted
- Date: 2026-08-08

## Context

Issue ベースで複数 agent を回すには、指揮と実作業の分離、session 寿命の違い、permission の集約点が必要。

検討した方向:

| 案 | 概要 |
|----|------|
| SDK のみ | conductor も worker も SDK subagent。実装は単純だが worker 分離・ACP permission 仲介が弱い |
| ACP のみ | すべて `agent acp`。conductor の長寿命・Issue 横断判断が扱いづらい |
| **スター型（採用）** | conductor = SDK 長寿命、worker = ACP 短命 session |

## Decision

- 複数 agent は **conductor 1 点**に接続するスター型。worker 同士は直接通信しない
- **conductor**: `@cursor/sdk`（`ensemble issue`）
- **worker**: `agent acp`（worktree 上で Skill に沿って自律実行）
- 共有の正本は **Issue / PR**（会話履歴は共有媒体にしない）
- worker はセッション開始時に起動し、permission は conductor 経由（inbox + broker）

詳細は [architecture.md](../architecture.md)。

## Consequences

- 良い: 役割と認証経路が明確。Stage ごとに層を足しやすい
- 悪い: SDK と ACP の二系統（認証・デバッグ・テストが増える）
- フォロー: integration は層ごと（ACP ブリッジ → dispatch → WorkerSession）、e2e は最後のゲート（[testing-strategy.md](../testing-strategy.md)）
