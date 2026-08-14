# ADR 0018: team-profile の 4 層配置と名前解決

- Status: accepted
- Date: 2026-08-14

## Context

[#176](https://github.com/otolab/agents-ensemble/issues/176) 以前、プロファイル（team 体制・役割分担の定義）は同梱 `profiles/<name>/` とリポジトリ直下 `profiles/<name>/` の 2 系統のみだった。Skill は worker 環境から探索される一方、team-profile は harness が解決する必要がある。

不足していたもの:

- ユーザ全体で共有する team 定義（毎 repo にコピー不要）
- プロジェクトの `.ensemble/` 配下に sessions / worktrees と並ぶ team 定義
- [#174](https://github.com/otolab/agents-ensemble/issues/174) の profile 選択 UI 向けカタログ API

Skill との概念対応: **Skill = 作業手順の正本**、**team-profile = チーム体制・起動文書の正本**（[ADR 0004](0004-profile-agents-without-fixed-skills.md)）。profile に Skill 名は埋め込まない。

## Decision

### 配置

| 層 | パス | source |
|----|------|--------|
| プロジェクト | `<repoRoot>/.ensemble/teams/<name>/profile.yaml` | `project` |
| ユーザ | `~/.ensemble/teams/<name>/profile.yaml` | `user` |
| 同梱 | `profiles/<name>/profile.yaml`（ビルド後 `dist/profiles/`） | `bundled` |
| レガシー | `<repoRoot>/profiles/<name>/profile.yaml` | `legacy` |

エントリファイル名は **`profile.yaml` のみ**（`teams/<name>/` で自明）。

### 名前解決（`--profile <name>`）

パスっぽい ref（`.yaml` / `/` 含む / 絶対パス）は従来どおりファイル指定。

名前のみの優先順: **project > user > bundled > legacy**。

### 組み込み default

- 内部名: `implementer-and-reviewer`
- CLI / API エイリアス: `default`（`--profile default` は同梱 `profiles/implementer-and-reviewer/` を解決）
- 一覧 API の `id`: `implementer-and-reviewer@bundled`

### core API

- `teamProfileRoots(repoRoot)` — 探索ルート一覧
- `resolveTeamProfilePath(ref, { repoRoot })` — 1 パスに解決
- `listTeamProfiles({ repoRoot })` — 全層列挙。各エントリに `id`（`name@source`）、`name`、`source`、`path`、`meta?`、`workersPreview`
- `loadProfile` / `resolveProfilePath` は上記経路に接続

`meta` フィールド（`id` / `title` / `summary`）は Profile スキーマに追加。未指定時はディレクトリ名等でフォールバック。

### CLI

- `ensemble profiles list` — `listTeamProfiles` のラッパー
- `--profile` help を 4 層 + パス指定に更新

## Consequences

- 良い: プロジェクト・ユーザ・同梱・レガシーを一貫した優先順で解決できる。[#174](https://github.com/otolab/agents-ensemble/issues/174) がカタログ API を利用可能
- 悪い: 4 層あるため同名衝突時の挙動を理解する必要がある（解決は上位優先、一覧は全層表示）
- レガシー `profiles/<name>/` は非推奨のまま維持。新規は `.ensemble/teams/` を推奨
- フォロー: harness `list_profiles` / `select_profile`（#174）で本 API を利用

## 関連

- [ADR 0004](0004-profile-agents-without-fixed-skills.md) — Skill 非固定（本文は不変）
- [elements.md](../elements.md) § プロファイル
- [user-teams.md](../user-teams.md) — `~/.ensemble/teams/` 規約
