---
"@agents-ensemble/core": patch
"@agents-ensemble/operator-agent": patch
---

一括移行で ResumeStore と sidecar を canonical slug 側へ非破壊で複製し、移行済み session では slug を正本として選びます。YAML と operator state も選択 location に沿って読み書きし、重複診断と UDS watch / live tool の経路を保ちます。
