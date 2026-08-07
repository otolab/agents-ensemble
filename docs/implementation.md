# 実装方針（検討）

技術構成の正本は [architecture.md](architecture.md)。本文は要約とメモ。

[my-logs#2027](https://github.com/otolab/my-logs/issues/2027) のコメントを反映。

## 推奨方向

**SDK conductor + ACP worker/reviewer**（詳細は architecture.md）

| 要素 | 方針 |
|------|------|
| conductor | SDK 長寿命 Agent。実作業ツールは持たない |
| worker / reviewer | フェーズごとに ACP 新 session（Skill 鮮度） |
| 承認 | サブの permission → conductor →（必要時）人間 |
| 状態 | Issue / PR + 任意の作業基準文書（スキーマ固定しない） |

## 段階導入

architecture.md §10 と同じ。

1. CLI スケルトン + 手動 dispatch 相当
2. conductor Agent が `gh` / CI を読み、判断して dispatch
3. 明確なケースから広げる（遷移ルールの機械化はしない）

## テスト

[testing-strategy.md](testing-strategy.md) を正本とする。

- **unittest**: ACP ブリッジの核（Fake server、transport）。CI 必須
- **integration**: 実 `agent acp` との session ライフサイクル。設定時のみ
- **e2e**: `ensemble` CLI 縦切り。Stage 1 完了ゲートは #6

Stage 1 は #3（ACP ブリッジ）を unittest → integration の順で作りきってから #6（e2e）に進む。

## 既存資産との分担

| 既存 | 役割 |
|------|------|
| CONDUCTOR_MODE | オーケの行動原則 |
| 秘書スキル | エスカレーション・tasks |
| periodic-checker | 通知・トリガー入力 |
| 作業 / レビュー Skill | worker / reviewer が読む手順 |

## 人間が残す箇所

- PR マージ
- 曖昧な判断
- スキル改善の最終承認
