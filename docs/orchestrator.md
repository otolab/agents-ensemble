# オーケストレータ（ensemble）

## 位置づけ

- **スター型の中心** — 複数の worker agent を接続・制御する
- **思考の実体としてフルセットの Agent** — 演奏しない
- CONDUCTOR_MODE 相当: 理解・判断・dispatch・permission 制御・エスカレーション
- **遷移は機械化しない** — Issue / PR / CI を読んで判断

## 責務

| 責務 | 内容 |
|------|------|
| 状態把握 | Issue / PR / CI / コメントを読む |
| 遷移判断 | 次にどの worker 種別を起動するか（オーケの判断） |
| dispatch・制御 | worker を起動し、permission（自動許諾含む）で制御する |
| エスカレーション | 判断不能時に人間へ（CLI） |

## worker との関係

- worker は種別（implementer / reviewer / librarian 等）を持ち、**自律的に** Skill に沿って動く
- worker 同士は直接通信しない。報告と状態は **Issue / PR** に書き、他 worker が読む
- 作業とプロセスは **1 Issue + worktree** に紐づく

## 作業基準文書（外から与える）

オーケが参照する補助資料を、都度・外から渡せるようにする。

- 名前・形式は固定しない
- フロー / Issue / プロジェクトごとに差し替え
- Skill（共通）とあわせてオーケの入力になる
- **プロファイル** が種別ごとの Skill・起動文書を返す

## 実装の方向

- SDK で長寿命の conductor Agent
- worker は ACP でタスク単位の新 session
- worker の `request_permission` は conductor が受け、ポリシーで自動許諾するか人間へ

技術詳細は [architecture.md](architecture.md)。要約は [implementation.md](implementation.md)。
