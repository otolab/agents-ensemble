# agents-ensemble

Issue を指定して起動する、エージェントオーケストレーション CLI。

`ensemble` がオーケストレータ（指揮者）として worker / reviewer 等を起動し、作業を進める。権限や方針の問題は Issue に記載して回答を待つか、CLI からユーザーに最小限問い合わせる。

## ステータス

Stage 2 まで実装済み（SDK conductor + ACP worker + e2e smoke）。詳細は [docs/](docs/) と GitHub Issues を参照。

## ドキュメント

[docs/](docs/) に設計・検討事項を整理している。技術構成の正本は [docs/architecture.md](docs/architecture.md)（SDK conductor + ACP worker）。

## 認証

agents-ensemble は **SDK（conductor）** と **ACP（worker）** の2系統を使う。認証ストアは共有されない。

| 経路 | 技術 | 何に使うか | ローカル開発 | CI / 自動化 |
|------|------|-----------|-------------|------------|
| **conductor** | `@cursor/sdk` | `ensemble issue` | `ensemble auth login` | `CURSOR_API_KEY` |
| **worker** | `agent acp` | `ensemble dispatch worker`、conductor からの dispatch | `agent login` | `CURSOR_API_KEY`（子プロセスへ継承） |
| **Issue 取得** | `gh` CLI | conductor が Issue 本文・コメントを読む | `gh auth login` | `GH_TOKEN` 等 |

### 初回セットアップ（ローカル）

```bash
# worker 用（agent CLI）
agent login
agent status

# conductor 用（SDK）
pnpm ensemble auth login
pnpm ensemble auth status

# Issue 取得用
gh auth login
```

`agent login` だけでは **conductor には渡りません**。`ensemble issue` を使う場合は `ensemble auth login` を別途一度実行してください。

### conductor（SDK）の認証解決順

`@cursor/sdk` は次の順で API key を探します（`ConductorAgent` も同じ）。

1. `apiKey` オプション（明示指定）
2. 環境変数 `CURSOR_API_KEY`
3. `ensemble auth login` で保存したキー（`~/.cursor/sdk/auth.json`）

```bash
# CI やスクリプト向け（ローカル stored login の代わり）
export CURSOR_API_KEY="cursor_..."
```

Dashboard からキーを発行する場合: [Cursor Dashboard → API Keys](https://cursor.com/dashboard/api)

### worker（ACP）の認証

worker は `spawn('agent', ['acp'])` で起動し、**子プロセスの `agent` が自分で認証**します。親（ensemble）は API key を渡しません。子プロセスは `process.env` を継承するため、`CURSOR_API_KEY` を設定していればそれも使えます。

### コマンド別の前提

| コマンド | 必要な認証 |
|---------|-----------|
| `ensemble dispatch worker` | `agent login` または `CURSOR_API_KEY` |
| `ensemble issue` | 上記 + `ensemble auth login`（または `CURSOR_API_KEY`）+ `gh auth login` |
| `pnpm test:integration` | `agent login` + `test-acp.yaml` |
| `pnpm test:e2e` | 上記 + `ensemble auth login` + `gh` + `test-acp.yaml`（`issueUrl` 等） |

### モデル指定

conductor のデフォルトモデルは `composer-2.5`。team 設定でブロックされる場合は `--model` で変更します。

```bash
ensemble issue <issue-url> --repo-root <path> --model auto
```

e2e では `test-acp.yaml` の `conductorModelId`（未指定時 `auto`）を使います。

## 開発

```bash
pnpm install
pnpm build
pnpm ensemble --help

# テスト（testing-strategy.md 参照）
pnpm test:run           # unittest（CI 必須）
pnpm test:integration   # 実 agent acp（test-acp.yaml 要）
pnpm test:e2e           # CLI 縦切り（test-acp.yaml 要）

# e2e 設定（初回）
cp packages/core/test/integration/test-acp.yaml.example \
   packages/core/test/integration/test-acp.yaml
# issueUrl / skillName: e2e-smoke / repoRoot を編集してから:
pnpm test:e2e

# Stage 1: 手動 worker dispatch
ensemble dispatch worker <issue-url> --skill <name> --repo-root <path>

# Stage 2: conductor オーケストレーション
ensemble issue <issue-url> --repo-root <path> [--resume <agentId>] [--model <id>]
```

認証の詳細は上記 [認証](#認証) を参照。

## ライセンス

MIT
