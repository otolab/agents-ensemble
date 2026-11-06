---
"@agents-ensemble/core": minor
---

Codex・Claude・Pi の worker ACP preset では、model catalog の model / reasoning を各 adapter の経路に渡します。Cursor の model-only 指定は、公式 CLI option `--model <model>` に catalog の値をそのまま渡すところまでを ensemble の契約とします。これは Cursor 内部で実際に選ばれた推論先を attestation するものではなく、その確認を毎回の受け入れ条件にはしません。model ID に reasoning suffix が含まれる場合の具体的な挙動は未検証で、forum #159748 の確認を [Issue #638](https://github.com/otolab/agents-ensemble/issues/638) に残しています。Cursor で別の `reasoning` または `cursorFast` を明示すると、独立した設定経路がないため worker の起動前に失敗します。`cursorFast` を省略した場合は picker capability と `fast` setter を送らず、Cursor CLI の既定選択に任せます。実際に選ばれる variant は未確認です。
