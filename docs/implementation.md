# 実装方針（検討）

技術構成の正本は [architecture.md](architecture.md)。本文は要約とメモ。

[my-logs#2027](https://github.com/otolab/my-logs/issues/2027) のコメントを反映。

## 推奨方向

**SDK conductor + ACP worker**（スター型。詳細は architecture.md）

| 要素 | 方針 |
|------|------|
| conductor | SDK 長寿命 Agent。実作業ツールは持たない。worker の起動・permission・エスカレーションを制御 |
| worker | 種別ごとに ACP 新 session。自律実行。状態は Issue / PR に書く |
| 承認 | worker の permission → conductor（自動許諾含む）→ 必要時のみ人間 |
| 状態 | Issue / PR + worktree + 任意の作業基準文書（スキーマ固定しない） |

## 段階導入

architecture.md §10 と同じ。

1. CLI スケルトン + 手動 dispatch 相当
2. conductor Agent が `gh` / CI を読み、判断して dispatch
3. permission 仲介、reviewer 種別のループ、CLI 人間エスカレーション

以降（#20 非同期化の完了など）は別 Issue。プロファイルは `profiles/` に置き、`build` で `dist/profiles/` へコピー。詳細は [elements.md](elements.md)。

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
| periodic-checker | 通知・トリガー入力 |
| 作業 / レビュー Skill | worker が読む手順 |

## 人間が残す箇所

- PR マージ
- 曖昧な判断
- スキル改善の最終承認
