# 開発環境

> **正本:** 本リポジトリのローカル開発・テスト・worktree のセットアップ。

## 前提

Node.js 22 と、ルート `package.json` の `packageManager` に指定された pnpm を使用する。Corepack も利用できる。

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

`ensemble issue` の isolated モードは Issue ごとに `.ensemble/worktrees/issue-N` を切る。各 worktree は独自の `node_modules` が必要。

このリポジトリは pnpm の **global virtual store**（`enableGlobalVirtualStore`）を有効にしている。メイン worktree で一度 install した後は、同一マシン上の 2 本目以降の worktree で install がほぼ symlink の張り替えだけになる（[pnpm: Git Worktrees](https://pnpm.io/git-worktrees)）。

```bash
# メイン worktree（初回または lockfile 更新後）
pnpm install

# Issue worktree など、別 worktree に入った後
cd .ensemble/worktrees/issue-42
pnpm install --frozen-lockfile
```

正常終了した isolated session の worktree は自動削除される。未コミット変更がある場合は削除されず、ローカルブランチ `ensemble/issue-N` は残る。

## テスト

テストレベルの定義と使い分けは [testing-strategy.md](testing-strategy.md) を参照する。

```bash
# unittest（CI 必須）
pnpm test:run

# 実 agent acp を使う integration test（test-acp.yaml が必要）
pnpm test:integration

# CLI 縦切りの e2e test（test-acp.yaml が必要）
pnpm test:e2e
```

Ink / React / `ink-testing-library` の更新、または TUI の resize 配線を変更する場合は、3 系統の回帰ゲートと判定基準を [Ink / React アップグレード回帰手順](tui-ink-upgrade.md) に従って確認する。

integration / e2e の設定を初めて作る場合:

```bash
cp packages/core/test/integration/test-acp.yaml.example \
   packages/core/test/integration/test-acp.yaml
```

`test-acp.yaml` の `issueUrl` / `repoRoot` などを環境に合わせて編集してからテストを実行する。認証や外部サービスを含む前提は [testing-strategy.md](testing-strategy.md) に記載している。

ローカルセッションを確認する場合は、ビルド後に次を実行する。詳細なオプションや利用者向け手順は [cli/README.md](cli/README.md) を参照する。

```bash
ensemble issue <issue-url> --repo-root <path>
```

## リリース

パッケージ変更を含む PR には changeset を追加する。手順は [prompts/release.md](prompts/release.md)、changeset の概要は [.changeset/README.md](../.changeset/README.md) を参照する。

## ブランチ運用（エージェント向け注意）

| 種類 | マージ先 | 備考 |
|------|----------|------|
| **通常の PR**（機能・修正・docs・changeset 追加） | **main** | パッケージ変更時は changeset 必須 |
| **Release PR**（CI 自動生成） | **main** | `release/X.Y.Z` → main。マージで npm 公開・GitHub Release |

**エージェントがしてはいけないこと**:

- 通常 PR の base を `release/*` にする（changeset の正本は main）
- **main への merge・push**（利用者が明示したときのみ）
- Release PR のマージ（リリース判断は人間）
