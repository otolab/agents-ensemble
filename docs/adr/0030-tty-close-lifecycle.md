# ADR 0030: TTY `/close` の再開可能な終了契約

- Status: accepted
- Date: 2026-10-18
- Related: [Issue #458](https://github.com/otolab/agents-ensemble/issues/458), [PR #465](https://github.com/otolab/agents-ensemble/pull/465), [ADR 0011](0011-session-sidecar-resume.md), [ADR 0013](0013-process-lifecycle-vs-autonomous-loop.md), [ADR 0017](0017-conductor-send-lifecycle-events.md), [ADR 0023](0023-tty-initial-message-post-loop.md)

## Context

[ADR 0013](0013-process-lifecycle-vs-autonomous-loop.md) は、自律ループの停止と TTY process の終了を分け、通常の TTY を post-loop で入力待ちにする判断を定めた。[ADR 0023](0023-tty-initial-message-post-loop.md) は、初回メッセージの有無でその待機を変えないことを明確にした。一方、両 ADR は post-loop から終了する操作を主に `/exit` として説明しており、作業状態を残して同じ Issue を続けるための一時終了の意味は定義していなかった。

`/exit` は isolated worktree の cleanup を試みる。cleanup failure を warning にとどめ exit 0 とする挙動は [Issue #448](https://github.com/otolab/agents-ensemble/issues/448) の契約である。Ctrl+C / SIGINT は実行を割り込む signal であり、再開前提の終了操作ではない。これらを `/close` と同じものとして案内すると、「cleanup を試みて終える」「割り込む」「状態を残して一時退室する」という異なる意図が混ざる。また worker ACP や Pi の stdio MCP child を生かしたまま TTY だけを閉じても、終了の期待を満たさない。

必要なのは、TTY process と `/close` が所有する資源を終了させながら、ローカル worktree と既存 resume 機構が使う識別子を残す明示的な操作である。

## Decision

### 操作の意味

| 操作 | オペレータの意図 | 終了後の扱い |
|------|------------------|--------------|
| `/close` | 作業を一時退室し、あとで同じ Issue を続ける | resource teardown 後に TTY process を成功終了する（exit 0）。sidecar を保存し worktree cleanup はしない |
| `/exit` | セッションを終え、通常の cleanup を行う | TTY process を終了し、isolated worktree cleanup を試みる。cleanup failure は warning のみで exit 0 とする #448 の契約を維持する |
| Ctrl+C / SIGINT（および SIGTERM） | 実行を割り込み・中断する | signal shutdown を `interrupted` として扱う。worktree removal はせず、`/close` の再開操作にも `/exit` にも置き換えない |

### `/close` は終了であって detach ではない

TTY で `/close` を受けたら、post-loop 中か自律作業中かにかかわらず、終了フィードバックを出し、TTY process を post-loop に残さず終了する。正常に完了した close は `stopReason: completed` と exit 0 になる。sidecar flush failure は warning として報告して終了を続ける。worker prompt を cancel し、未解決 permission を deny してから、monitor・worker・conductor と close path が所有する child handle を teardown する。これは detach ではない。

teardown では、attach 済み worker の ACP session ID / cwd を runtime の attached-worker 一覧から snapshot して sidecar 状態に反映する。これは通常 `worker.completed` で session ID が記録される前でも行い、最初の worker prompt が in-flight 中に `/close` した場合の再開情報を保つ。sidecar には conductor ID、worker 状態、open question、GitHub monitor cursor / pending outbox などを残す。worktree removal event は発行せず、worktree path 自体も sidecar へ保存しない。

同じ repo で `ensemble issue <same> --continue` を実行すると、harness は `issueUrl` / `repoRoot` などから同じ Issue worktree を再導出して再利用し、sidecar の `conductorAgentId` から conductor を再開する。保存された ACP session ID と cwd が現在の worker 設定に整合すれば `session/load` する。保存 ACP session を load できない場合は [ADR 0011](0011-session-sidecar-resume.md) に従い `session/new` と bootstrap prompt に切り替わる。この場合、以前の worker transcript は復元されない。profile / backend 等の不整合は既存の fail-fast / attach failure 契約に従う。worktree path は sidecar のフィールドではなく、repo と Issue から harness が解決する。

Ctrl+C / SIGINT（および SIGTERM）は引き続き interruption として扱い、`stopReason: interrupted` と既存の signal shutdown / best-effort flush を行う。worktree removal は明示的な `/exit` のときだけ試みる。signal shutdown 後に sidecar が残ることは、`/close` が提供する再開選択を意味しない。

### shutdown 中の永続化と重複

`/close` の順序は、worker prompt の cancel と attached ACP session ID / cwd の snapshot、pending permission の deny、monitor の stop と最新 cursor / pending outbox の取得、sidecar flush、worker と conductor の force stop である。close sidecar flush は best effort で、失敗しても warning を出して teardown を続ける。したがって再開時に見えるのは最後に永続化された状態であり、最新更新を失う、古い sidecar から再開する、または usable sidecar がなく再開に失敗する可能性がある。

GitHub monitor の更新は at-least-once とする。conductor send が `finished` として完了した後だけ更新 ID を outbox から ack する。`/close` が先に要求されると、その send が shutdown 中に完了しても ack を行わず、resume 後に再配送する。send 完了後、ack と cursor の sidecar 永続化の間に crash した場合も、永続化済み outbox から再配送して重複しうる。close 開始後に返った poll は cursor に commit せず、resume が再 poll する。exactly-once 配送は保証しない。

### 永続化しない状態と対象外

- 未解決の permission は teardown で deny し、[ADR 0011](0011-session-sidecar-resume.md) の方針どおり sidecar に保存・再開しない。
- in-flight の conductor send、Driver の実行状態、send の再開位置は保存しない。close で中断された send を継続・再実行する hot pause ではない（[ADR 0017](0017-conductor-send-lifecycle-events.md)）。
- sidecar はローカルの再開記録であり、別マシンへの持ち運びや remote worktree の保持は保証しない。backend が session を復元できない、または保存情報と起動時設定が整合しない場合の扱いは既存 resume 契約に従う。
- GitHub monitor の stop は poll 完了を最大 5s 待ち、超過時 abort 後さらに最大 500ms 待つ。worker ACP child は stdin EOF 後 500ms、SIGTERM 後 5s、SIGKILL 後最大 2s の回収を試みる。Pi resumable close は session を abort / unsubscribe し、MCP を無効にして reload してから dispose する。これらの個別待機値は teardown 全体の期限ではない。
- `/close` の process termination guarantee は、正常な close 経路が post-loop に留まらず、所有する monitor・ACP worker・conductor・Pi stdio MCP resource の teardown 後に exit 0 で終わることを指す。sidecar flush failure は warning であり、最新 checkpoint の保存保証ではない。Pi stdio MCP の close 固有経路を含むが、#457 が扱う `/exit` 等の一般的な child cleanup 全般を解決したという判断ではない。

### 関連 ADR との境界

- **ADR 0013** の「自律ループ停止と process termination は別」という基礎判断と `shouldStopIssueLoop` の意味を維持する。TTY は自律ループ停止後も通常どおり post-loop で入力を待ち、`/close` はその待機から明示終了する操作である。
- **ADR 0011** の sidecar schema、conductor / worker resume、permission 非永続、best-effort flush の判断は変更しない。本 ADR はそれらを利用して同じ Issue を続ける方法を定める。
- **ADR 0023** の「初回メッセージがあっても TTY post-loop 待機を維持する」判断を変えない。`/close` はその待機から終了する選択肢であり、非 TTY one-shot と `--no-wait` の契約も変えない。
- **Issue #457** の一般的な process / child cleanup remediation は別スコープのままとする。ここで扱うのは `/close` の終了契約に必要な teardown と Pi の stdio MCP handle を close 経路で解放することに限る。

## Consequences

- オペレータは、一時退室して resume するなら `/close`（正常終了 exit 0）、terminal cleanup なら `/exit`（cleanup failure も warning・exit 0）、割り込みなら Ctrl+C / SIGINT（`interrupted`）を使い分ける。
- `/close` は process を終了しながら worktree と再開に必要な sidecar data を残す。worktree path 自体は保存せず、同じ Issue から再導出する。
- worker prompt と pending permission は中断・deny され、in-flight conductor send は resume しない。monitor は at-least-once のため重複しうる。best-effort flush は最新 checkpoint の無損失を保証しない。
- process termination と Pi stdio MCP child teardown は `/close` の close-specific 対象である。ほかの終了経路全般の process leak remediation は #457 に残る。
