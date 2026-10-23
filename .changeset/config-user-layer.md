---
'@agents-ensemble/core': minor
'@agents-ensemble/cli': minor
'@agents-ensemble/operator-agent': minor
---

`ensemble issue` と `ensemble operator-agent` で `--config <path>` を指定し、標準 user config を指定ファイルに差し替えて起動できるようにしました。project config は独立した層として引き続き適用され、同じ項目では project 側が優先されます。

session sidecar には解決済み config の digest を記録し、resume 時に設定変更を検出します。
worker ACP fingerprint は env の digest のみを保持し、環境変数の値を sidecar に残しません。
