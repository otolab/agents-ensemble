# ensemble 共通設定（config.yaml）

`.ensemble/config.yaml` は harness 横断の設定の正本。team-profile（`profile.yaml`）や conductor SDK 認証とは別系統。

## 配置と解決順

| 層 | パス | 優先度 |
|----|------|--------|
| プロジェクト | `<repoRoot>/.ensemble/config.yaml` | 高（上書き） |
| ユーザ | `~/.ensemble/config.yaml` | 低（既定） |

- 両方ある場合は **deep merge**（プロジェクトがユーザを上書き）
- どちらも無い場合は **コード内デフォルト**
- **環境変数・CLI フラグは config より優先**（明示上書き）

### 設定項目ごとの解決順（Phase 1）

すべての Phase 1 キーで次の順序を **実装・テストで固定**している:

```
CLI 明示指定 > 環境変数 > project .ensemble/config.yaml > user ~/.ensemble/config.yaml > コード内デフォルト
```

`loadEnsembleConfig(repoRoot)` は user → project の順で merge した `EnsembleConfig` を返す。各 `resolve*Setting` はその merged config を **config 層**として参照する。

`ensemble issue` 起動時（GitHub monitor / Issue コンテキスト取得より前）に config を読み込む。

## テンプレート

リポジトリ直下の [`config.example.yaml`](../config.example.yaml) をコピーして使う。実運用の config は `.ensemble/` 配下のため **gitignore 対象**（方針 A）。チームで共有したい非秘密項目だけ example を更新する。

```bash
mkdir -p .ensemble
cp config.example.yaml .ensemble/config.yaml
# またはユーザ全体
mkdir -p ~/.ensemble
cp config.example.yaml ~/.ensemble/config.yaml
```

## スキーマ（Phase 1）

```yaml
profile:
  default: implementer-and-reviewer   # ENSEMBLE_DEFAULT_PROFILE 相当

conductor:
  model: default                      # CONDUCTOR_MODEL_ID 相当

acp:
  defaultPreset: cursor               # ENSEMBLE_DEFAULT_ACP_CLI 相当

session:
  worktree: isolated                  # --worktree 既定（isolated | in-repo）
  maxTurns:
    tty: 0                            # 0 = 無制限
    nonTty: 5
  postLoop:
    wait: true                        # TTY 時 post-loop 待機（--no-wait で上書き）

github:
  auth:
    allowGhAuthTokenFallback: true
  monitor:
    enabled: true
    debounceMs: 30000
    pollIntervalMs: 60000
    activePollIntervalMs: 15000
    stopPollWaitMs: 5000
```

### キー一覧

| キー | 意味 | CLI 上書き | env 上書き |
|------|------|-----------|-----------|
| `profile.default` | 既定 team profile（名前またはパス） | `--profile` | `ENSEMBLE_DEFAULT_PROFILE` |
| `conductor.model` | conductor モデル id | `--model` | `CONDUCTOR_MODEL_ID` |
| `acp.defaultPreset` | worker ACP built-in preset | `--default-acp-cli` 等 | `ENSEMBLE_DEFAULT_ACP_CLI` |
| `session.worktree` | worker workspace モード | `--worktree` | — |
| `session.maxTurns.tty` / `nonTty` | 自律ターン上限 | `--max-turns` / `--no-max-turns` | — |
| `session.postLoop.wait` | post-loop 待機（TTY） | `--no-wait` | — |
| `github.auth.allowGhAuthTokenFallback` | `gh auth token` フォールバック | — | — |
| `github.monitor.enabled` | Issue / PR 監視 | `--no-github-monitor` | — |
| `github.monitor.debounceMs` | 更新 debounce | `--github-monitor-debounce-ms` | — |
| `github.monitor.pollIntervalMs` 他 | poll 間隔（コード内既定のみ） | — | — |

profile / worker に `acp` がある worker は `--default-acp-*` / config `acp.defaultPreset` より **profile 側が優先**（従来どおり）。

### GitHub 認証トークンの解決順

`resolveGitHubAuthToken({ config })`（`@agents-ensemble/core`）:

1. 環境変数 `GITHUB_TOKEN`
2. 環境変数 `GH_TOKEN`
3. `config.github.auth.allowGhAuthTokenFallback: true` のときのみ `gh auth token`

`allowGhAuthTokenFallback: false` のときは **`gh auth token` を呼ばない**。CI 等では `GH_TOKEN` / `GITHUB_TOKEN` を明示設定すること。

## 移行表（env → config）

| 従来（env / コード default） | config キー | 備考 |
|------------------------------|-------------|------|
| `ENSEMBLE_DEFAULT_PROFILE` | `profile.default` | env は CI 上書き用として維持 |
| `CONDUCTOR_MODEL_ID` | `conductor.model` | 同上 |
| `ENSEMBLE_DEFAULT_ACP_CLI` | `acp.defaultPreset` | 同上 |
| CLI `--worktree` 既定 `isolated` | `session.worktree` | |
| TTY 無制限 / 非 TTY 5 | `session.maxTurns.tty` / `nonTty` | |
| TTY post-loop 待機 ON | `session.postLoop.wait` | |
| monitor 各種定数 | `github.monitor.*` | |

**config 未作成時**は従来どおり env とコード default のみが効く（後方互換）。

## 秘密情報を config に書かない

**token 本体を config に平文で保存しない。** 認証は環境変数、`gh auth login`、将来の stored credential 経路（別 Issue）を使う。

## スキーマ外キー

YAML に未知のキーがあっても **無視する**（警告なし）。将来のスキーマ拡張用に残してよい。既知キーで型が合わない値も **該当キーのみ**無視し、下位層またはデフォルトにフォールバックする。

## 関連

- [ADR 0020](adr/0020-ensemble-config-setting-resolution.md) — 解決順の設計判断
- [ADR 0018](adr/0018-team-profile-four-layer-resolution.md) — `.ensemble/` 配下の規約（team-profile）
- [#223](https://github.com/otolab/agents-ensemble/issues/223) — config 基盤
- [#228](https://github.com/otolab/agents-ensemble/issues/228) — Phase 1 拡張
