# 構成要素

## skill（作業スキル）

- 基本的にこれに沿って進む
- 改善フローは**最後**（SKILL / CASE_STUDIES 更新）
- レビュー用 Skill を独立して作る場合あり（例: `config-checker-fix` + `config-checker-fix-review`）

| 文書 | 役割 |
|------|------|
| `SKILL.md` | 手順・原則（作業中） |
| `CASE_STUDIES.md` | 過去の型（作業後に読み返す） |

## worker

- **思い込みを減らす**ため、種別ごとに独立 session で起動する
- 共有は **Issue / PR / ファイル**
- conductor が種別・Skill・起動文書を与えて制御する

| 種別（例） | 役割 | worktree |
|-----------|------|----------|
| implementer | 実装・Issue・PR・対応・依頼・クローズ | 作成 |
| reviewer | 独立検証 | 既存に入る |
| librarian | ドキュメント整備・所在調査 | 対象 repo 次第 |

種別はプロファイルで定義する。Skill と worker 用システムプロンプトを返す。

## プロファイル

同梱プロファイルはリポジトリ直下の `profiles/` に置く。`@agents-ensemble/core` の `build` 時に `dist/profiles/` へコピーされ、実行時はそこ（未ビルド時はソースの `profiles/`）を参照する。

- `--profile` 省略時: 同梱 `default`（implementer + 役割分担 materials）
- `agents.<kind>` … agent の modular-prompt 拡張（`prompt` インライン / `promptFile` 外部 YAML）。未指定時は ensemble base のみ
- `workers` … 起動する worker（`name` + `kind`）。`- ping` は name=kind の省略形
- Skill は profile に固定しない。materials で自然言語指示し、worker が必要に応じて読み込む

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
