---
'@agents-ensemble/core': patch
---

ACP の pipe 切断時に JSON-RPC write error が未処理例外にならず、進行中の worker ラウンドへ伝播するようにしました。
