# リリースガイド

`@agents-ensemble/core` と `@agents-ensemble/cli` のリリース手順。フローは [modular-prompt](https://github.com/otolab/modular-prompt) を踏襲する。

## 自動リリースフロー概要

### ワークフロー

1. **version-update.yml** — `release/*` ブランチへの push 時
   - changeset を適用してパッケージバージョンを更新
   - 各パッケージの CHANGELOG を自動生成
   - ルート `package.json` のバージョンをブランチ名から更新
   - main への Release PR を自動作成

2. **release.yml** — `release/*` ブランチからの PR マージ時
   - ビルド・テスト・型チェック
   - Git タグ `vX.Y.Z` を作成
   - GitHub Release を作成
   - npm へ公開（Trusted Publisher）

## 日常開発

パッケージに変更を入れた PR では changeset を追加する。

```bash
pnpm changeset
```

`@agents-ensemble/core` と `@agents-ensemble/cli` は **fixed** グループのため、常に同じバージョンでリリースされる。

CI の `changeset-check` が PR に changeset の有無を検証する。ドキュメントのみの変更などでスキップする場合は、コミットメッセージに `[skip-changeset]` を含める。

## リリース手順

### 1. main に changeset が蓄積されていることを確認

```bash
ls .changeset/*.md | grep -v README.md
```

### 2. リリースブランチを作成して push

```bash
git checkout main
git pull origin main
git checkout -b release/1.0.0   # または release/v1.0.0

git push -u origin release/1.0.0
```

**重要**: ブランチ名 `release/X.Y.Z` のバージョンが、ルート `package.json` のバージョンになる。子パッケージのバージョンは changeset の内容に従う。

### 3. CI による自動処理

`release/*` への push 後、version-update が次を実行する。

1. `pnpm changeset version`
2. ルート `package.json` をブランチ名のバージョンに更新
3. `pnpm-lock.yaml` を更新してコミット・push
4. main 向け Release PR を作成

### 4. PR のレビューとマージ

```bash
gh pr list --head release/1.0.0
gh pr view <PR番号>
```

確認項目:

- [ ] `packages/cli/CHANGELOG.md` / `packages/core/CHANGELOG.md` の内容
- [ ] バージョン番号
- [ ] CI がパスしている

### 5. マージ後の自動リリース

PR マージ後、release ワークフローがビルド・テスト後に npm 公開と GitHub Release を行う。

### 6. 完了確認

```bash
gh release view v1.0.0
npm view @agents-ensemble/cli version
npm view @agents-ensemble/core version
```

## バージョン管理

- **子パッケージ** (`@agents-ensemble/*`): changeset が semver を決定
- **ルート** (`agents-ensemble`, private): `release/X.Y.Z` ブランチ名で決定

## 初回 npm 公開

初回は npm 側の Trusted Publisher 設定が必要。各パッケージで次を設定する。

1. [npmjs.com](https://www.npmjs.com/) でパッケージを作成（空で可）
2. Settings → Publishing access → Trusted publishers
3. Provider: GitHub Actions / Organization: `otolab` / Repository: `agents-ensemble` / Workflow: `release.yml`

または手動で一度公開する。

```bash
pnpm build
cd packages/core && pnpm publish --access public
cd ../cli && pnpm publish --access public
```

## トラブルシューティング

### npm 公開が失敗する

Trusted Publisher 未設定、または npm CLI が古い。release ワークフローは npm 11.5.1 以上にアップグレードする。

### PR に changeset が無いと CI が落ちる

```bash
pnpm changeset
git add .changeset/
git commit -m "chore: add changeset"
```

### バージョンが期待と異なる

- `.changeset/*.md` の bump 種別（patch/minor/major）を確認
- リリースブランチ名が意図した `release/X.Y.Z` か確認

## 関連

- [.changeset/README.md](../.changeset/README.md)
- [Changesets](https://github.com/changesets/changesets)
- [Issue #138](https://github.com/otolab/agents-ensemble/issues/138)
