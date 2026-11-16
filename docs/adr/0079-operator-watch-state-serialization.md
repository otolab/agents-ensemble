# ADR 0079: operator-agent watch state の process 間直列化

- Status: accepted
- Date: 2026-11-16
- Related: [ADR 0037](0037-operator-agent-session-watch-and-dispatch.md), [ADR 0038](0038-operator-agent-conversation-report-hold.md), [ADR 0078](0078-operator-agent-session-report-coalescing.md), [Issue #736](https://github.com/otolab/agents-ensemble/issues/736)

## Context

watch pool は profile state file 全体を読み込み、repository ごとの file を atomic rename で保存する。同じ profile を使う複数 process が同じ file を読み込んで並行 poll すると、後から保存した古い snapshot が先の process の cursor と pending report を上書きできる。file 単位の atomic rename だけでは、read / modify / write の競合を防げない。

もう一つ、複数の oversized-message warning を最初の warning の位置にまとめると、間に到着した readable message や別 report より後の warning が前に表示される。report と message の到着順を保つ契約に反する。

## Decision

- 同じ profile の watch state 更新に profile 単位の cross-process file lock を使う。lock を取得してから全 state file を読み直し、session identity の検証、poll cursor と pending report の更新、ack / 登録変更、atomic save を同じ lock 内で行う。poll は observation を読む間も lock を保持し、別 process が同じ cursor から先に進むことを防ぐ。
- lock を取得できない操作は保存せず error とする。別の poll / retry で再試行できる。lock は 20 秒ごとに heartbeat を更新し、120 秒更新されない場合は stale lock recovery の対象とする。lock が失われたと検知した場合、保存前に error とする。lock acquisition は有限回で打ち切り、永久待機にはしない。
- oversized warning は到着順で隣り合う warning だけをまとめる。間に readable message または別 report がある場合は warning を分けて表示し、各 sendCount の前後関係を維持する。
- report ID、cursor / pending report の永続化、再起動後の retry と ack は ADR 0037 / 0078 の at-least-once 契約を保つ。複数 process の in-memory dispatch queue にすでに載った report までは共有しないため、重複配送はありうる。exactly-once delivery は約束しない。

## Consequences

- 複数 process の古い snapshot が後勝ちで cursor / pending report を消すことを防ぐ。ack は lock 内で最新 state を読み、acknowledge された report ID だけを除く。
- profile 内の poll は session / repository をまたいで直列に進むため、同時に多数の session を監視すると poll の遅延が増える。lock の取得・poll が失敗した場合は state を書き換えず、次の実行に委ねる。
- OS suspend などで process が 120 秒を超えて heartbeat を更新できない場合、stale lock recovery が別 process に lock を渡すことがある。復帰後に lock 消失を検知した更新は rename 前に失敗させるが、長時間停止をまたいだ process 間の exactly-once dispatch は保証しない。
- adjacent warning は一つにまとめられるが、意味のある message / report をまたいだ warning は個別 section に残る。これは短い表示より時系列を優先する。
- file ごとの atomic save は維持する。profile 内の複数 file をまたぐ crash-atomic transaction や process 間 exactly-once dispatch は提供しない。
