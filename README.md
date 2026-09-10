# agents-ensemble

GitHub Issue を起点に、conductor が worker を起動・制御して作業を進めるエージェントオーケストレーション CLI です。

`ensemble` は SDK conductor と ACP worker を使うスター型の構成です。現行の技術構成は [docs/architecture.md](docs/architecture.md) を参照してください。

## ステータス

Stage 2 まで実装済み（SDK conductor + ACP worker + e2e smoke）。実装状況と設計判断は [docs/](docs/) と GitHub Issues に記録しています。

## 利用者向け CLI

npm パッケージのインストールから最初の `ensemble issue` までの手順は [docs/cli/README.md](docs/cli/README.md) を参照してください。

設定の全体一覧・環境変数・解決順は [docs/settings.md](docs/settings.md)、`config.yaml` の書き方は [docs/config.md](docs/config.md)、TUI とオペレータ入力の挙動は [docs/operator-input.md](docs/operator-input.md) が正本です。

## ドキュメント

文書は読者別に [docs/README.md](docs/README.md) へ整理しています。

開発時に特に参照する文書:

| 文書 | 内容 |
|------|------|
| [docs/architecture.md](docs/architecture.md) | 現行の技術構成・プロセス分離・通信経路 |
| [docs/testing-strategy.md](docs/testing-strategy.md) | unittest / integration / e2e の分類と実行方針 |
| [docs/RELEASE_GUIDE.md](docs/RELEASE_GUIDE.md) | changeset・Release PR・npm 公開手順 |
| [docs/adr/](docs/adr/README.md) | 設計判断の履歴 |
| [AGENTS.md](AGENTS.md) | エージェント・人間共通の作業とレビュー指針 |

## 開発環境

Node.js 22 と、ルート `package.json` の `packageManager` に指定された pnpm を使用します。Corepack も利用できます。

```bash
corepack enable   # 初回のみ（任意）
pnpm install
pnpm build
pnpm ensemble --help
```

`@agents-ensemble/core` をライブラリとして利用する場合:

```bash
pnpm add @agents-ensemble/core
```

## git worktree と依存インストール

`ensemble issue` の isolated モードは Issue ごとに `.ensemble/worktrees/issue-N` を切ります。各 worktree は独自の `node_modules` が必要です。

このリポジトリは pnpm の **global virtual store**（`enableGlobalVirtualStore`）を有効にしています。メイン worktree で一度 install した後は、同一マシン上の 2 本目以降の worktree で install がほぼ symlink の張り替えだけになります（[pnpm: Git Worktrees](https://pnpm.io/git-worktrees)）。

```bash
# メイン worktree（初回または lockfile 更新後）
pnpm install

# Issue worktree など、別 worktree に入った後
cd .ensemble/worktrees/issue-42
pnpm install --frozen-lockfile
```

正常終了した isolated session の worktree は自動削除されます。未コミット変更がある場合は削除されず、ローカルブランチ `ensemble/issue-N` は残ります。

## テスト

テストレベルの定義と使い分けは [docs/testing-strategy.md](docs/testing-strategy.md) を参照してください。

```bash
# unittest（CI 必須）
pnpm test:run

# 実 agent acp を使う integration test（test-acp.yaml が必要）
pnpm test:integration

# CLI 縦切りの e2e test（test-acp.yaml が必要）
pnpm test:e2e
```

integration / e2e の設定を初めて作る場合:

```bash
cp packages/core/test/integration/test-acp.yaml.example \
   packages/core/test/integration/test-acp.yaml
```

`test-acp.yaml` の `issueUrl` / `repoRoot` などを環境に合わせて編集してからテストを実行します。認証や外部サービスを含む前提は [docs/testing-strategy.md](docs/testing-strategy.md) に記載しています。

ローカルの Stage 2 セッションを確認する場合は、ビルド後に次を実行します。詳細なオプションや利用者向け手順は [docs/cli/README.md](docs/cli/README.md) を参照してください。

```bash
ensemble issue <issue-url> --repo-root <path>
```

## リリース

パッケージ変更を含む PR には changeset を追加します。手順の正本は [docs/RELEASE_GUIDE.md](docs/RELEASE_GUIDE.md)、changeset の概要は [.changeset/README.md](.changeset/README.md) を参照してください。

## ライセンス

MIT
