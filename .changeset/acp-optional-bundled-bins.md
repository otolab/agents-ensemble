---
"@agents-ensemble/core": minor
"@agents-ensemble/cli": patch
---

built-in ACP preset（`claude` / `codex` / `pi`）の `npx` 起動を廃止し、`optionalDependencies` 同梱 bin → PATH → 明示エラーの順で spawn する。spawn 前に外部 CLI（`agent` / `pi` 等）の存在チェックと install 手順付き fail fast を追加。
