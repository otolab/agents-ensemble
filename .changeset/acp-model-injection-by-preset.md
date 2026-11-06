---
"@agents-ensemble/core": minor
---

Codex・Claude・Pi の worker ACP preset では、model catalog の model / reasoning を各 adapter の経路に渡します。Cursor は `--model` に要求値を渡すだけで、実際の推論先は保証しません。Cursor に `reasoning` または `cursorFast` を明示すると、runtime への適用を確認できないため worker の起動前に失敗します。`cursorFast` を省略した場合は picker capability と `fast` setter を送らず、Cursor CLI の既定選択に任せます。実際に選ばれる variant は model / CLI によって変わり得て、この変更では確認していません。
