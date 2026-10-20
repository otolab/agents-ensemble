---
"@agents-ensemble/core": minor
"@agents-ensemble/cli": minor
"@agents-ensemble/operator-agent": minor
---

稼働中の Issue harness にセッション単位 UDS control API を追加し、operator-agent から Open Question の一覧取得と回答を行えるようにしました。終了時の dispatch drain は最大 5 秒とし、回答が保存済み・dispatch 未確認の場合は outcome unknown を返し、停止後の再送で二重回答が起きないようにします。
