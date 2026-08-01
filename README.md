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
```

## ライセンス

MIT
