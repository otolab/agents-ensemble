# 構成要素

## skill（作業スキル）

- 基本的にこれに沿って進む
- 改善フローは**最後**（SKILL / CASE_STUDIES 更新）
- レビュー用 Skill を独立して作る場合あり（例: `config-checker-fix` + `config-checker-fix-review`）

| 文書 | 役割 |
|------|------|
| `SKILL.md` | 手順・原則（作業中） |
| `CASE_STUDIES.md` | 過去の型（作業後に読み返す） |

## worker / reviewer

- **思い込みを減らす**ため独立インスタンス
- 共有は **Issue / PR / ファイル**

| | worker | reviewer |
|---|---|---|
| 役割 | 実装・Issue・PR・対応・依頼・クローズ | 独立検証 |
| worktree | 作成 | 既存に入る |
| スキル | 作業 Skill | レビュー Skill |

## issue

- 調査・検討・結果を**簡潔に、頻繁に**コメント
- description は checkbox の check 以外は基本触らない

## PR

- 差分 + レビューと対応の履歴
- description も Issue と同様

## auto-docs

- 汎用ナレッジのレジストリ（例: `karte-auto-docs`）
- `search-docs` 活用。作業時にも読める
- ケースによって更新（別 PR もあり）

## レビューの注意

- 味見で終わらない。背景・波及の調査が本筋
