---
"@agents-ensemble/core": minor
"@agents-ensemble/cli": minor
"@agents-ensemble/operator-agent": minor
---

operator-agent を専用 profile と global conversation に分離し、user session の repository scope とページングを追加します。Issue session data と旧 watch state は保全を確認できる read fallback と copy-only migration を使います。
