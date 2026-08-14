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
| implementer | 実装・Issue・PR・対応・依頼・クローズ | Issue worktree（既定） |
| reviewer | 独立検証 | 既存に入る |
| librarian | ドキュメント整備・所在調査 | profile の `workspace` で別 cwd 可 |

種別はプロファイルで定義する。Skill と worker 用システムプロンプトを返す。

## プロファイル（team-profile）

team-profile は **チーム体制・役割分担・起動文書**の正本（Skill の `skills/` に相当する概念は `teams/`）。スキーマは現行 `Profile`（`workers` / `agents` / `materials` / 任意 `meta`）をそのまま使う。

### 4 層の配置

| 層 | パス | 優先度 |
|----|------|--------|
| プロジェクト | `<repo>/.ensemble/teams/<name>/profile.yaml` | 最高 |
| ユーザ | `~/.ensemble/teams/<name>/profile.yaml` | ↑ |
| 同梱 | `profiles/<name>/profile.yaml`（`build` で `dist/profiles/` にコピー） | ↑ |
| レガシー | `<repo>/profiles/<name>/profile.yaml`（非推奨） | 最低 |

`--profile <name>` の名前解決は上記優先順。パス指定（`.yaml` / `/` / 絶対パス）は従来どおり。

デフォルト profile の優先順位:

| 順 | ソース |
|----|--------|
| 1 | CLI `--profile <ref>` |
| 2 | 環境変数 `ENSEMBLE_DEFAULT_PROFILE`（空文字は未設定扱い） |
| 3 | 同梱 `profiles/implementer-and-reviewer/`（`default` エイリアス） |

`ENSEMBLE_DEFAULT_PROFILE` の値は `--profile` と同じ解釈（名前またはパス）。
- 一覧: `ensemble profiles list`（`id` は `name@source` 形式）
- ユーザ層の規約: [user-teams.md](user-teams.md)
- 設計判断: [ADR 0018](adr/0018-team-profile-four-layer-resolution.md)

### フィールド

- `meta` … 任意。一覧・選択 UI 向け（`id` / `title` / `summary`）。未指定時はディレクトリ名等でフォールバック
- `agents.<kind>` … agent の modular-prompt 拡張（`prompt` インライン / `promptFile` 外部 YAML）。未指定時は ensemble base のみ
- `workers` … 起動する worker（`name` + `kind`）。`- ping` は name=kind の省略形
- `workers[].workspace` … **任意**。その worker の ACP 起動 cwd（`agent acp` の `session/new` / `session/load`）。**Issue worktree（`--repo-root` + Issue から導出）とは別概念**。省略時はセッション共通の Issue worktree を使う。`~` / `~/...` は homedir() で展開。相対パスは profile ディレクトリ（`./` / `../`）または repo-root 基準
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
