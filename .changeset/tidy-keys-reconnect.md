---
'@agents-ensemble/core': patch
'@agents-ensemble/cli': patch
---

Pi の API key 認証失敗を分類し、失敗 dispatch の内容を TTY で確認できる recovery inbox と、失敗 dispatch を再送しない安全な recovery report を追加します。
