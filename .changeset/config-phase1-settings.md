---
"@agents-ensemble/core": minor
"@agents-ensemble/cli": minor
---

`.ensemble/config.yaml` を Phase 1 キー（profile / conductor / acp / session / github.monitor）まで拡張し、解決順 `CLI > env > project config > user config > コード default` を `resolve*Setting` とテストで統一。`ensemble issue` が config 既定を参照する。ドキュメント・ADR 0020 追加。
