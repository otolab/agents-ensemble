# AGENTS.md

このリポジトリで作業・レビューするエージェント（および人間）向けの共通指針。

技術構成の正本は [docs/architecture.md](docs/architecture.md)。セッションのログ・表示は [docs/session-logging.md](docs/session-logging.md)。設計判断の履歴は [docs/adr/](docs/adr/README.md)。

## レビュー方針

レビューは **PR を単位とした完結性** を判定する。単体テストが通ることや diff がきれいなことだけでは approve にならない。

### 観点（二層）

| 層 | 問い | 検出すべき問題 |
|----|------|----------------|
| **目的** | この PR / Issue が解こうとしていることに対して妥当か | 設計ミス、考慮漏れ、トレードオフの未記録、利用者視点の欠落 |
| **実装** | コードとドキュメントが正しく、リポジトリと整合しているか | 掃除漏れ、参照の矛盾、ライフサイクル上の穴、テストの抜け、破壊的変更の未記載 |

両方を満たすまで **approve しない**（deny / request changes）。

### PR 完結性

- **原則**: PR は、紐づく Issue の受け入れ条件と、変更が及ぼす利用者・運用面（CLI、README、ADR、architecture）まで **この PR 内で完結** していること。
- **例外**: 次の Issue に **明示的に** 逃がす場合のみ、PR に含めなくてよい。
  - Issue または ADR に「本 PR では行わない」「#N で対応」と **手順として意図的にスキップ** すると書いてあること
  - スキップする理由と、残るリスクが読者に分かること
- **認めない逃げ方**:
  - 「フォロー」「任意」「マージ後で可」だけで、Issue / ADR に逃がし先が無いもの
  - ADR の Consequences に一行あるだけで、Issue 化・受け入れ条件の更新が無いもの
  - 主ユースケース（例: 止めて resume）を壊す既知の穴を「スコープ外」とラベルするだけのもの

迷ったら **deny**。例外にするなら、逃がし先 Issue を先に作り、PR 本文で参照する。

### ライフサイクル・永続化を扱う PR

状態を保存・再開する機能では、次を **目的層の要件** として扱う（「後で困るかも」ではない）。

| 項目 | 要件 |
|------|------|
| 停止経路 | 正常終了だけでなく、利用者が実際に使う停止（例: SIGINT）でも状態が一貫して片付くこと |
| 再開の一貫性 | harness 状態と SDK / ACP 状態が食い違う「半分 resume」を黙って進めないこと |
| 欠損時の扱い | sidecar 不在・復元失敗時は、operator と conductor の両方に整合した通知、または起動失敗 |
| 利用者向けドキュメント | CLI 変更・出力変更は [README.md](README.md) に反映（architecture が README を参照している場合は必須） |

非永続にする状態（例: pending permission）があるなら、**accepted risk** として ADR に理由・失敗モード・運用上の制限を書く。「スコープ外」の一言だけでは不十分。

### レビュー出力

GitHub 上のレビューコメントは冒頭に `*🤖 by Cursor*` を付ける（人間も同様でよい）。

- **deny / request changes**: 目的層・実装層のどちらで足りないかを分けて書く。マージ前に直すものと、Issue 逃がしが正当なものを混同しない。
- **approve**: 受け入れ条件とレビュー観点を満たした根拠を簡潔に書く。未解決を「任意」として残さない。

### チェックリスト（PR レビュー時）

1. Issue の受け入れ条件を列挙し、PR で満たしているか対応表を頭の中（またはコメント）で作る
2. 主ユースケースを一行で述べ、その経路がコードと docs で通るか追う
3. 削除・リネームした API / CLI 出力の参照がリポジトリ内に残っていないか検索する
4. テストが主ユースケースを担保しているか（ユニットだけで縦切りが抜けていないか）
5. README / ADR / architecture のどれが利用者向け正本か確認し、矛盾がないか見る
6. 「次の Issue」に逃がす項目は、Issue 番号とスキップ理由が PR / ADR にあるか

## リリース・ブランチ

手順の正本は [docs/RELEASE_GUIDE.md](docs/RELEASE_GUIDE.md)。

| 種類 | マージ先 | 備考 |
|------|----------|------|
| **通常の PR**（機能・修正・docs・changeset 追加） | **main** | パッケージ変更時は changeset 必須（[.changeset/README.md](.changeset/README.md)） |
| **Release PR**（CI 自動生成） | **main** | `release/X.Y.Z` → main。マージで npm 公開・GitHub Release |

**リリースの流れ（人間が実行）**: main に changeset が蓄積 → main から `release/X.Y.Z` を作成して push → version-update CI が Release PR を作成 → レビュー・マージ → publish。

**エージェントがしてはいけないこと**:

- 通常 PR の base を `release/*` にする（changeset の正本は main）
- **main への merge・push**（利用者が明示したときのみ）
- Release PR のマージ（リリース判断は人間）

## 作業環境（git worktree）

`ensemble issue` の isolated モードでは Issue ごとに **git worktree**（`.ensemble/worktrees/issue-N`）で作業する。各 worktree は独自の `node_modules` が必要。

本リポジトリは pnpm の **global virtual store**（`enableGlobalVirtualStore`）を有効にしている。メイン worktree で一度 `pnpm install` 済みなら、**2 本目以降の worktree では `pnpm install` がほぼ即時**（symlink 張り替え中心）になる。install を省略しないこと。

```bash
cd .ensemble/worktrees/issue-42
pnpm install --frozen-lockfile
```

詳細は [README.md — git worktree と依存インストール](README.md#git-worktree-と依存インストール)。
