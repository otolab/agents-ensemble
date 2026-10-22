# リリース手順

> **参照:** `@agents-ensemble/core`、`@agents-ensemble/cli`、`@agents-ensemble/operator-agent` の changeset・Release PR・npm 公開手順。

フローは [modular-prompt](https://github.com/otolab/modular-prompt) を踏襲する。

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

`@agents-ensemble/core` と `@agents-ensemble/cli` は **fixed** グループのため、常に同じバージョンでリリースされる。`@agents-ensemble/operator-agent` は独立したバージョンで管理する。

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

初回 push 時点では changeset ファイルを残しておく。`Version Update` が changeset を適用し、各パッケージの CHANGELOG と lockfile を更新して release ブランチへ push する。ブランチ名 `release/X.Y.Z` の版はルート `package.json` に使い、公開パッケージの版は changeset に従う。

### 3. CI による自動処理

changeset が残っている状態で `release/*` に push すると、`Version Update` が次を実行する。

1. `pnpm changeset version`
2. ルート `package.json` を release ブランチ名のバージョンに更新
3. `pnpm-lock.yaml` を更新してコミット・push
4. main 向け Release PR を作成または確認

Release PR が開いている間に main へ追加変更が入り、changeset も追加された場合は、release ブランチへ main を取り込んだ後、ローカルで changeset を適用してから push する。

```bash
git checkout release/1.0.0
git fetch origin
git merge origin/main
pnpm changeset version
pnpm install --lockfile-only
git add .changeset packages pnpm-lock.yaml
git commit -m "chore: apply changesets on release branch"
git push
```

この push では、変更された公開パッケージの version と各 CHANGELOG が push 前から更新されていることを `Version Update` が確認する。changeset の適用済みと判定した場合、workflow は package version・ルート version・lockfile を書き換えず、Release PR の作成または確認を行う。更新対象の全パッケージで version と CHANGELOG の変更が確認できない場合は、適用済みとは扱わず、changeset 未記録として失敗する。

`[skip-changeset]` を使う場合、初回の release ブランチ push ではルート version のみをブランチ名に合わせる。ブランチ作成後の push ではルート version を書き換えない。特に公開パッケージの version と CHANGELOG が同じ push で更新されている場合は、changeset 適用済みとしてすべての version をそのまま保つ。これにより release ブランチ名の版で、より新しいルート version を上書きしない。

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

- [.changeset/README.md](../../.changeset/README.md)
- [Changesets](https://github.com/changesets/changesets)
