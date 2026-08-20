---
"@agents-ensemble/core": minor
"@agents-ensemble/cli": minor
---

GitHub 情報取得を `gh` CLI から REST / GraphQL API 直接呼び出しへ移行。`GITHUB_TOKEN` / `GH_TOKEN` 設定時は `gh` 未インストールでも Issue 取得・GitHub 監視が動作する。認証フォールバックとして `gh auth token` のみ残す。GitHub 認証失敗時は conductor 認証と区別された `[github-auth]` 復旧ヒントを表示する。
