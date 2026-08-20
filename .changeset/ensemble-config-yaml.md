---
"@agents-ensemble/core": minor
---

`.ensemble/config.yaml` の 2 層解決（user → project deep merge）と `loadEnsembleConfig` API を追加。GitHub 認証解決 API（`resolveGitHubAuthToken`）が `github.auth.allowGhAuthTokenFallback` を参照する。`ensemble issue` 起動時に config を読み込む。
