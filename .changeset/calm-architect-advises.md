---
"@agents-ensemble/core": patch
"@agents-ensemble/cli": patch
---

設計相談役の worker `architect` を置いた team profile `with-architect` を同梱します。`ensemble issue <N> --profile with-architect` で起動できます。architect は conductor から渡された情報をもとに設計上の助言を返し、コードの変更や探索的な調査、判定は行いません。
