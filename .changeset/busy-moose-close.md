---
'@agents-ensemble/cli': minor
'@agents-ensemble/core': patch
---

TTY に `/close` を追加し、Pi conductor の resumable close では stdio MCP 子プロセスを停止してから session を dispose する
