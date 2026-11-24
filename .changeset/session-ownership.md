---
"@agents-ensemble/core": minor
"@agents-ensemble/cli": patch
---

Prevent concurrent session writers from overwriting each other. Core persistence callers must acquire the appropriate session or resource ownership and pass a write lease.
