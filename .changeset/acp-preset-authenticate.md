---
"@agents-ensemble/core": patch
"@agents-ensemble/cli": patch
---

worker ACP attach 時の `authenticate` を preset 別に解決する。`codex` は `chat-gpt` で Codex CLI ログインを再利用、`claude` / `pi` は skip、`cursor` は `cursor_login` 維持。
