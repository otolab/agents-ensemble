---
"@agents-ensemble/core": patch
---

Session resume は worktree mode と ACP preset の変更を検出し、model や env の変更は resume 拒否理由にしないようにします。旧 sidecar は従来の digest scheme を保ちます。
