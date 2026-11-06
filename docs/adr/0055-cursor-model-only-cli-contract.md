# ADR 0055: Cursor worker の model-only 指定を公式 CLI 契約で受け入れる

- Status: accepted
- Date: 2026-11-06
- Related: [ADR 0054](0054-cursor-acp-runtime-verification.md), [Issue #630](https://github.com/otolab/agents-ensemble/issues/630), [Issue #638](https://github.com/otolab/agents-ensemble/issues/638)

## Context

Cursor の公式 CLI reference は `--model <model>` を「使用するモデル」の指定として掲載し、ACP docs は `agent acp` を custom client / integration 向けの起動方法として説明している（[CLI parameters](https://prod.cursor.com/docs/cli/reference/parameters)、[ACP docs](https://prod.cursor.com/docs/cli/acp)）。現在の worker は catalog から解決した `model` 値を `agent --model <id> acp` にそのまま渡し、spawn fingerprint にも要求値を記録する。

[ADR 0054](0054-cursor-acp-runtime-verification.md) は、ACP `currentValue` が Agent の報告値であって、内部で使われた runtime model の attestation ではない点を記録した。一方で、公式 CLI の model selection option を利用する model-only 経路を受け入れ条件として認める範囲は明確でなかった。レビューでは runtime model の確認を求められたが、オペレータは inq-3 で、公式の指定方法に従って値を渡すことを model-only の機能契約とし、上流内部の選択結果を毎回証明することまでは要求しないと判断した。

Cursor forum #159748 は、CLI `2026.05.04-08e5280` で model ID の reasoning suffix が落ちたという具体的な報告である。オペレータは inq-2 で認証付き確認を PR 引き渡し後に行うと決めており、その再現は別途 [Issue #638](https://github.com/otolab/agents-ensemble/issues/638) で追跡している。

## Decision

- Cursor の model-only 指定では、model catalog の値を公式 CLI option `--model <model>` へそのまま渡す。`agent --model <id> acp` までの正確な受け渡しを ensemble 側の機能契約とし、各 session で内部 runtime model / variant の attestation を得ることは受け入れ条件にしない。
- spawn 引数、fingerprint、`sessionModels` は catalog から解決した要求値を表す。これらや ACP `configOptions.currentValue` を、上流 runtime がその値を使った証明とは記録しない。
- `reasoning` / `cursorFast` を独立した config field として明示した場合は、別個の安定した公式注入契約がないため、引き続き spawn 前に fail fast する。`cursorFast` 省略時は capability / setter を送らず Cursor CLI の既定選択に委ねる。
- model ID に reasoning suffix が含まれる場合も、値は `--model` にそのまま渡す。ただし、その suffix が特定の CLI build でどう扱われるかは確認済みとみなさない。forum #159748 の具体的な再現確認は Issue #638 で引き渡し後に行い、runtime 情報を取得できた場合は観測結果として記録する。runtime attestation は model-only の一般要件にしない。
- #616 に基づく resume 方針は変えない。新しい `resume-feasibility` store では model / reasoning / `acp.env` は診断用に記録し、拒否判定には使わない。旧 scheme 省略 / `full` store の従来比較も維持する。

## Consequences

- 公式 CLI の model selection option に従う model-only 経路は、内部 runtime を独立に観測できなくても ensemble の受け渡し契約を満たす。
- forum #159748 の suffix 問題が解消したとは主張しない。専用の認証付き確認で再現結果を記録し、確認できなかった範囲は未検証のまま残す。
- Cursor の別 `reasoning` / `cursorFast` field は引き続き fail fast する。model ID の pass-through を runtime 適用保証へ読み替えない。
