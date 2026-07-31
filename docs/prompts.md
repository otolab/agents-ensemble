# 起動プロンプト

自然言語ベース。`logs/[prompt]` 等にテンプレを置き、Issue URL / PR URL を差し替える。

## 独立起動のブートストラップ

コンテキスト 0 のエージェント向け（例）:

```
personaとfoundationモードを有効にしてください。本文をresourceから読み込むのも忘れずに。
```

## 作業開始（worker）

- worktree **作成**
- 作業 Skill を指定
- 作業対象 Issue URL

## セルフレビュー（reviewer）

- worktree **既存に参加**
- レビュー Skill を指定
- 作業対象 PR URL

```
worktreeを作成しているので、そこに入って検討します。
```

## 汎用（薄い起動文）

```
次のIssueに対応してください。
{Issue URL}

作業ブランチを切り、worktreeを作成して作業します。
SKILL文書に沿って丁寧に作業してください。

調査結果や作業方針決定のタイミングで、Issueに小さく報告するようにしてください。
```

参照: `my-logs/logs/2026-w28-w31.md` — `[config-checker-fix] の開始プロンプト`
