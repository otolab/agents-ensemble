# 起動プロンプト

自然言語ベース。conductor が dispatch 時に worker へ渡す起動文書。種別ごとに Skill 名・Issue / PR URL を差し替える。

プロファイル（未実装）が種別ごとの **Skill 名** と **worker 用システムプロンプト** を返す想定。

## 独立起動のブートストラップ

コンテキスト 0 の worker 向け（例）:

```
personaとfoundationモードを有効にしてください。本文をresourceから読み込むのも忘れずに。
```

## implementer 種別

- worktree **作成**
- 作業 Skill を指定
- 作業対象 Issue URL

## reviewer 種別

- worktree **既存に参加**
- レビュー Skill を指定
- 作業対象 PR URL

```
worktreeを作成しているので、そこに入って検討します。
```

## librarian 種別

- 対象 repo / worktree（Issue 文脈に応じる）
- librarian Skill を指定
- 調査・整備対象を Issue / PR から読む

## 汎用（薄い起動文）

```
次のIssueに対応してください。
{Issue URL}

作業ブランチを切り、worktreeを作成して作業します。
SKILL文書に沿って丁寧に作業してください。

調査結果や作業方針決定のタイミングで、Issueに小さく報告するようにしてください。
```

参照: `my-logs/logs/2026-w28-w31.md` — `[config-checker-fix] の開始プロンプト`
