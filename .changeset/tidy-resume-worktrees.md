---
"@agents-ensemble/core": patch
---

既存の Issue 指定 API との互換性を維持し、セッション終了時に、resume 用の別パスを含めて実際に使った worktree を削除し、Git の管理一覧に見つからない場合は警告します。
