---
"@agents-ensemble/cli": patch
"@agents-ensemble/operator-agent": patch
---

`operator-agent --config` と同じ config namespace を使う管理コマンドを追加します。既定 config の保存先互換性を保ちながら、別 config の workspace・watch・scheduling state を分離します。
