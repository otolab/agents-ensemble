# ADR 0056: dispatch hold 中の permission stall 回復通知

- Status: accepted
- Date: 2026-11-06
- Related: [ADR 0027](0027-permission-stall-notification.md), [Issue #639](https://github.com/otolab/agents-ensemble/issues/639)
- Supersedes（部分的）: ADR 0027 の dispatch hold 中の扱いのみ

## Context

[ADR 0027](0027-permission-stall-notification.md) は、長時間 pending の permission を conductor が回復できるよう、低優先度の `permission.stall` trigger を追加した。一方、`set_dispatch_hold` は通常の worker / GitHub 報告による割り込みを抑えるため、`permission.stall` も held buffer に入れていた。

hold 中に worker が permission 待ちになり、conductor への `permission.pending` と `permission.stall` の両方が保留されると、conductor は hold の解除も permission 判断もできない。30 分 reminder は operator 向けの telemetry で、conductor を起こす経路にはならない。`permission.pending` 自体を hold 対象外にすると、通常の permission 依頼が会話中に割り込むため、hold の目的を損なう。

## Decision

- `permission.pending` と通常の worker / GitHub trigger は引き続き hold 対象とする。
- 既定 300 秒の閾値に達した `permission.stall` だけは hold 対象外とし、既存の低優先度のまま conductor へ dispatch する。同じ stall episode での通知回数・monitor 設定は ADR 0027 のまま維持する。
- 優先順位は dispatch 可能なイベント間で適用する。hold 中の `permission.pending` は対象外のため、stall が先に届く場合がある。`permission.stall` には permission request の詳細を含めず、conductor が判断材料を必要としたときは `set_dispatch_hold({ hold: false })` で解除して pending の詳細を受け取る。
- hold は自動解除しない。通知後も hold を続けるか、解除して permission を処理するかは conductor が判断する。
- max-turns 到達後も permission 回復のため `permission.stall` と `permission.pending` を dispatch できる既存例外を維持する。worker / GitHub trigger は従来どおり上限リセットまで dispatch しない。
- 30 分の `harness.warning` reminder は operator 向けのまま維持し、`permission.stall` とは別の通知として扱う。

## Consequences

- hold 中に permission が長時間停滞しても、閾値後に conductor が自律判断する契機が届く。通常の pending や作業報告は会話を中断しない。
- stall 通知だけでは操作内容を判断できない。conductor が詳細を確認するには hold を解除して `permission.pending` を受け取る必要がある。
- operator が長時間作業を止めたい場合も hold は自動解除されない。stall は回復判断を促すものであり、強制解除ではない。
