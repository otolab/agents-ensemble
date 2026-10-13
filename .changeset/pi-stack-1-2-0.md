---
'@agents-ensemble/core': patch
'@agents-ensemble/cli': patch
---

Pi 依存（`pi-agent-core` / `pi-ai` / `pi-coding-agent` / `pi-codemode`）を 1.2.0 に揃え、npm global install 時に `pi-codemode@1.2` と `pi-coding-agent@1.0` が混在して CLI 起動できなくなる問題を解消する（#426）。
