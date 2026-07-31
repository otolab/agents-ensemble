# オーケストレータ（ensemble）

## 位置づけ

- **思考の実体としてフルセットの Agent**
- 演奏しない — 実装・レビューは worker / reviewer に委任
- CONDUCTOR_MODE 相当: 理解・判断・dispatch・エスカレーション
- **遷移は機械化しない** — Issue / PR / CI を読んで判断

## 責務

| 責務 | 内容 |
|------|------|
| 状態把握 | Issue / PR / CI / コメントを読む |
| 遷移判断 | 次に誰を起動するか（オーケの判断） |
| dispatch | worker / reviewer / librarian を独立起動 |
| エスカレーション | 人間への依頼、秘書連携 |

## 作業基準文書（外から与える）

オーケが参照する補助資料を、都度・外から渡せるようにする。

- 名前・形式は固定しない
- フロー / Issue / プロジェクトごとに差し替え
- Skill（共通）とあわせてオーケの入力になる

## 実装の方向（検討）

- SDK で長寿命のオーケ Agent
- worker / reviewer は ACP 等でタスク単位の新 session
- サブの `request_permission` はオーケが受け、必要時に人間へ

詳細は [implementation.md](implementation.md)。
