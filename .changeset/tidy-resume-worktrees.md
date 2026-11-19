---
"@agents-ensemble/core": patch
---

セッション終了時に、resume 用の別パスを含めて実際に使った worktree を削除し、Git の管理一覧に見つからない場合は警告します。
