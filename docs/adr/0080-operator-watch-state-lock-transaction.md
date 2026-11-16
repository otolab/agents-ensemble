# ADR 0080: operator-agent watch state を SQLite transaction lock で保護

- Status: accepted
- Date: 2026-11-16
- Supersedes in part: [ADR 0079](0079-operator-watch-state-serialization.md)（stale lease と lock-loss handling のみ）
- Related: [ADR 0037](0037-operator-agent-session-watch-and-dispatch.md), [ADR 0038](0038-operator-agent-conversation-report-hold.md), [ADR 0078](0078-operator-agent-session-report-coalescing.md), [Issue #736](https://github.com/otolab/agents-ensemble/issues/736)

## Context

ADR 0079 の `proper-lockfile` は heartbeat が120秒止まると lock を stale とみなし、別 process に取得権を渡す。長時間停止していた元 process が復帰すると、保存直前の in-memory assertion が lock 消失をまだ検知していない隙に、別 owner が保存した JSON を stale snapshot で置き換えられる。assertion を rename の直前へ置いても、確認と rename の間に競合が残る。

JSON file の世代番号を確認してから rename する方法も、確認と置換を一つの atomic compare-and-swap にできない限り同じ隙間を残す。profile state の読み直しから保存完了まで、停止時間を理由に所有権が移らない排他が必要だった。

## Decision

- profile ごとに `watch-state-lock.sqlite` を作り、`node:sqlite` の `DatabaseSync` で `BEGIN IMMEDIATE` transaction を取得する。transaction は profile 内の state file を再読込し、Store / Issue identity を検証し、poll observation・cursor / pending report・ack・登録変更を保存する間、開いたままにする。SQLite の transaction は state payload の保存先ではなく、profile-wide の OS-managed lock として使う。
- 時間による lease expiry / takeover は行わない。process が suspend されても生存中は OS lock を保持し、別 process は所有権を奪わない。process が終了すれば OS が lock を解放し、次の process が取得できる。
- lock 取得は最大40回、25ms間隔で再試行する。取得できなければ明示的に error を返し、その操作では state を更新しない。timer poll は次の poll で再試行し、tool / API 操作の失敗は caller に返す。無期限待機はしない。
- `node:sqlite` を flag なしで使える Node.js 22.13.0 以上を、root / CLI / operator-agent の runtime minimum とする。`DatabaseSync` は Node.js 22.5.0 で追加され、22.13.0 から `--experimental-sqlite` が不要になる（[Node.js SQLite API](https://nodejs.org/api/sqlite.html)）。
- report ID、cursor / pending report の永続化、再起動時の retry と ack は ADR 0037 / 0078 の at-least-once 契約を保つ。state JSON は従来どおり repository ごとの atomic rename で保存する。

## Consequences

- lock ownership が保存直前の assertion に依存しない。古い mtime を持つ lock file があっても、生きている owner の transaction は奪えず、別 owner が先に保存してから旧 owner が上書きする経路を作らない。
- profile 内の poll は observation を含めて直列になる。owner が長時間 suspend すると、競合 process は最大約1秒の取得 retry 後に error となり、その回の state は更新しない。自動 poll は次回周期に再試行する。これは lease takeover より遅延を許容する設計で、無期限の lock 待ちや stale snapshot の保存を選ばない。
- process 終了時は OS lock が解放される。複数 repository の JSON file をまたぐ crash-atomic transaction は提供しない。各 file の rename は atomic だが、process が複数 file の保存途中で終了すると全 file を一括 rollback できない。
- file lock の保証は SQLite の OS locking を正しく実装する local filesystem を前提とする。SQLite locking を保証しない network / virtual filesystem は対象外。process ごとの in-memory dispatch queue は共有せず、ack 前の終了などによる at-least-once の重複配送は残る。

`BEGIN IMMEDIATE` は transaction の開始時に writer lock を取り、SQLite は同じ database に RESERVED lock を同時に一つだけ許す（[SQLite file locking](https://www.sqlite.org/lockingv3.html)）。
