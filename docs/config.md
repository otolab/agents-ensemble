# ensemble 共通設定（config.yaml）

`.ensemble/config.yaml` は harness 横断の設定の正本。team-profile（`profile.yaml`）や conductor SDK 認証とは別系統。

## 配置と解決順

| 層 | パス | 優先度 |
|----|------|--------|
| プロジェクト | `<repoRoot>/.ensemble/config.yaml` | 高（上書き） |
| ユーザ | `~/.ensemble/config.yaml` | 低（既定） |

- 両方ある場合は **deep merge**（プロジェクトがユーザを上書き）
- どちらも無い場合は **コード内デフォルト**
- 環境変数・CLI フラグは config より優先（明示上書き）

`ensemble issue` 起動時（GitHub monitor / Issue コンテキスト取得より前）に `loadEnsembleConfig(repoRoot)` で読み込む。

## テンプレート

リポジトリ直下の [`config.example.yaml`](../config.example.yaml) をコピーして使う。実運用の config は `.ensemble/` 配下のため **gitignore 対象**（方針 A）。チームで共有したい非秘密項目だけ example を更新する。

```bash
mkdir -p .ensemble
cp config.example.yaml .ensemble/config.yaml
# またはユーザ全体
mkdir -p ~/.ensemble
cp config.example.yaml ~/.ensemble/config.yaml
```

## 初期スキーマ

```yaml
github:
  auth:
    # GITHUB_TOKEN / GH_TOKEN が無いとき gh auth token を試すか（既定: true）
    allowGhAuthTokenFallback: true
```

### GitHub 認証トークンの解決順

`resolveGitHubAuthToken({ config })`（`@agents-ensemble/core`）:

1. 環境変数 `GITHUB_TOKEN`
2. 環境変数 `GH_TOKEN`
3. `config.github.auth.allowGhAuthTokenFallback: true` のときのみ `gh auth token`

`allowGhAuthTokenFallback: false` のときは **`gh auth token` を呼ばない**。CI 等では `GH_TOKEN` / `GITHUB_TOKEN` を明示設定すること。

## 秘密情報を config に書かない

**token 本体を config に平文で保存しない。** 認証は環境変数、`gh auth login`、将来の stored credential 経路（別 Issue）を使う。

## スキーマ外キー

YAML に未知のキーがあっても **無視する**（警告なし）。将来のスキーマ拡張用に残してよい。既知キーで型が合わない値（例: 真偽値以外の `allowGhAuthTokenFallback`）も無視し、下位層またはデフォルトにフォールバックする。

## 関連

- [ADR 0018](adr/0018-team-profile-four-layer-resolution.md) — `.ensemble/` 配下の規約（team-profile）
- [#223](https://github.com/otolab/agents-ensemble/issues/223) — 本設定の導入
- [#222](https://github.com/otolab/agents-ensemble/issues/222) — GitHub API 直接化（本 config の第一利用者）
