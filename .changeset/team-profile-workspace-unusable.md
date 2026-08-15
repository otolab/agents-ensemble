---
"@agents-ensemble/core": patch
"@agents-ensemble/cli": patch
---

workspace が存在しない（またはディレクトリでない）team profile を `unusable` として一覧表示し、`loadProfile` / `--profile` 起動前に拒否する。`ensemble profiles list` は `[unusable]` と issues を表示し、`--json` に `availability` / `issues` を含める。
