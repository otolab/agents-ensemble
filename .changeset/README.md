# Changesets

このディレクトリには、次回リリースで反映される変更内容を記述した changeset ファイルが格納されます。

## 使い方

パッケージに変更を加えた PR では changeset を追加してください。

```bash
pnpm changeset
```

## リリース

手順の正本は [docs/RELEASE_GUIDE.md](../docs/RELEASE_GUIDE.md)。

1. main に changeset が蓄積されていることを確認
2. `git checkout -b release/X.Y.Z` を main から作成して push（空ブランチ可）
3. CI がバージョン更新 PR を作成 → レビュー・マージ
4. npm 公開と GitHub Release が自動実行される
