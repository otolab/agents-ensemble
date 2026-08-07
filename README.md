# agents-ensemble

Issue を指定して起動する、エージェントオーケストレーション CLI。

`ensemble` がオーケストレータ（指揮者）として worker / reviewer 等を起動し、作業を進める。権限や方針の問題は Issue に記載して回答を待つか、CLI からユーザーに最小限問い合わせる。

## ステータス

設計・検討中。実装はこれから。

## ドキュメント

[docs/](docs/) に設計・検討事項を整理している。技術構成の正本は [docs/architecture.md](docs/architecture.md)（SDK conductor + ACP worker）。

## 開発

```bash
pnpm install
pnpm build
pnpm ensemble --help

# テスト（testing-strategy.md 参照）
pnpm test:run           # unittest（CI 必須）
pnpm test:integration   # 実 agent acp（test-acp.yaml 要）
pnpm test:e2e           # CLI 縦切り（#6 / #12、設定時）

# Stage 1: 手動 worker dispatch
ensemble dispatch worker <issue-url> --skill <name> --repo-root <path>

# Stage 2: conductor オーケストレーション
# 初回のみ: conductor 用 SDK ログイン（agent login とは別ストア）
ensemble auth login
ensemble issue <issue-url> --repo-root <path> [--resume <agentId>]
```

### 認証（SDK + ACP）

| 用途 | 何が効くか |
|------|-----------|
| worker（`agent acp`） | `agent login` |
| conductor（`@cursor/sdk`） | `ensemble auth login` / `CURSOR_API_KEY` / `~/.cursor/sdk/auth.json` |

`agent login` だけでは conductor には渡りません。`ensemble auth login` を一度実行するか `CURSOR_API_KEY` を設定してください。

## ライセンス

MIT
