# 実装方針（検討）

[my-logs#2027](https://github.com/otolab/my-logs/issues/2027) のコメントを要約。未確定。

## 推奨方向（案）

**SDK オーケ + ACP worker/reviewer**

| 要素 | 案 |
|------|-----|
| オーケ | SDK 長寿命 Agent。実作業ツールは持たない |
| worker / reviewer | フェーズごとに ACP 新 session（Skill 鮮度） |
| 承認 | サブの permission → オーケ →（必要時）人間 |
| 状態 | Issue / PR + 任意の作業基準文書（スキーマ固定しない） |

## 段階導入（案）

1. CLI スケルトン + 手動 dispatch 相当
2. オーケ Agent が `gh` / CI を読み、判断して dispatch
3. 明確なケースから自動化を広げる（遷移ルールの機械化はしない）

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
