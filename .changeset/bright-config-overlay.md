---
'@agents-ensemble/core': minor
'@agents-ensemble/cli': minor
'@agents-ensemble/operator-agent': minor
---

`ensemble issue` と `ensemble operator-agent` で `--config <path>` を指定し、user / project config に明示 config を重ねて起動できるようにしました。

session sidecar には解決済み config の digest を記録し、resume 時に設定変更を検出します。
worker ACP fingerprint は env の digest のみを保持し、環境変数の値を sidecar に残しません。
