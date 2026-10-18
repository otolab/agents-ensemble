# ADR 0030: TTY `/close` の再開可能な終了契約

- Status: accepted
- Date: 2026-10-18
- Related: [Issue #458](https://github.com/otolab/agents-ensemble/issues/458), [PR #465](https://github.com/otolab/agents-ensemble/pull/465), [ADR 0011](0011-session-sidecar-resume.md), [ADR 0013](0013-process-lifecycle-vs-autonomous-loop.md), [ADR 0017](0017-conductor-send-lifecycle-events.md), [ADR 0023](0023-tty-initial-message-post-loop.md)

## Context

[ADR 0013](0013-process-lifecycle-vs-autonomous-loop.md) は、自律ループが止まることと TTY プロセスが終わることを分け、通常の TTY を post-loop でオペレータ入力待ちにする判断を定めた。[ADR 0023](0023-tty-initial-message-post-loop.md) は、初回メッセージがあっても通常の TTY 待機を変えないことを明確にした。一方、そこではオペレータが意図して TTY を離れる操作は `/exit` を中心に説明しており、掃除を伴わず同じ Issue の作業を続けるために閉じる操作の意味は定義していなかった。

`/exit` は isolated worktree の cleanup を試みる。Ctrl+C / SIGINT は実行を中断する signal であり、オペレータが再開可能な終了を選んだことを表す専用コマンドではない。どちらかを `/close` の代わりに案内すると、「掃除まで終える」「中断する」「再開前提で一時退室する」という異なる意図が混ざる。また、worker ACP や Pi の stdio MCP のような子プロセスを生かしたまま TTY だけを閉じると、プロセス終了の期待を満たさない。

必要なのは、プロセスとその所有資源を終了させながら、ローカルの Issue worktree と既存 resume 機構が使う識別子を残す明示的な操作である。

## Decision

### 操作の意味

| 操作 | オペレータの意図 | 終了後の扱い |
|------|------------------|--------------|
| `/close` | 作業を一時退室する。あとで同じ Issue を続ける | owned resource を停止し TTY プロセスを終了する。worktree は掃除せず、sidecar を再開用に保存する |
| `/exit` | セッションを終え、通常の終了時 cleanup を行う | TTY プロセスを終了し、現行の isolated worktree cleanup を試みる。cleanup failure は warning のみで exit 0 とする既存契約を維持する |
| Ctrl+C / SIGINT（および SIGTERM） | 実行を割り込み・中断する | signal 経路で shutdown し、`interrupted` として扱う。worktree removal は行わないが、`/close` や `/exit` を入力した意味には置き換えない |

### `/close` は終了であって detach ではない

TTY で `/close` を受けたら、post-loop 中か自律作業中かにかかわらず、終了フィードバックを出し、セッションが所有する monitor・worker・conductor とその子ハンドルを停止した後、TTY プロセスを必ず終了する。プロセスを post-loop に残したり、worker の ACP process や Pi の MCP child を残したりしてはならない。worker の実行 prompt を cancel し、未解決 permission を deny する。Pi conductor は resumable close 用の shutdown を行い、stdio MCP 子プロセスを含む extension 資源を閉じてから session を dispose する。これは子プロセスを残して入力待ちを続ける detach 操作ではない。

終了前に attach 済み worker の ACP session ID と cwd を sidecar 用状態へ反映する。sidecar には既存の conductor ID、worker 状態、open question、GitHub monitor cursor / pending update など resume に必要な情報を残す。isolated worktree は削除せず、worktree removal event も発行しない。worktree path 自体は [ADR 0011](0011-session-sidecar-resume.md) のとおり sidecar から導出し、sidecar へ複製しない。

同じリポジトリで `ensemble issue <same> --continue` を実行すると、同一 Issue の sidecar を使って conductor を既存の `conductorAgentId` から再開し、保存された ACP session ID と cwd が利用可能かつ整合するとき worker を `session/load` する。Issue worktree は harness により解決・再利用される。`session/load` が失敗した場合は [ADR 0011](0011-session-sidecar-resume.md) のとおり `session/new` と bootstrap prompt にフォールバックする。profile / backend などの保存値が現在の設定と整合しない場合は既存の fail-fast / attach failure 契約が適用され、同じ worker transcript を必ず復元できるとは限らない。これは既存の sidecar / backend resume 機構に対する TTY からの明示的な終了経路であり、新しい transcript 保存方式ではない。

Ctrl+C / SIGINT（および SIGTERM）は引き続き interruption として扱い、`stopReason: interrupted` を記録して既存の signal shutdown / best-effort flush を行う。worktree removal は `/exit` が明示的に要求されたときだけ行う。signal shutdown 後に sidecar が残ることと、オペレータが再開前提の `/close` を選んだことは同じ意味ではなく、signal 経路に `/close` 固有の resume guarantee を追加しない。

### shutdown 中の永続化と重複

`/close` では monitor を止め、cursor と保留中の更新を含む sidecar 状態を flush してから worker / conductor の終了を完了する。close での sidecar flush は best effort である。保存に失敗しても終了を続け、警告を出す。したがって再開できるのは最後に保存された状態であり、close 直前の変更が必ず残るとは限らない。

GitHub monitor は at-least-once 配送とする。更新は conductor send が `finished` になった後に ack されるが、close が先に要求された send は完了しても ack されず、再開後に再配送されることがある。ack 後の sidecar 保存前にプロセスが落ちた場合や、stop 開始後に返った poll を cursor に commit しない場合にも重複しうる。close と再開をまたぐ更新の exactly-once 配送は保証しない。

### 永続化しない状態と対象外

- 未解決の permission は teardown で deny し、[ADR 0011](0011-session-sidecar-resume.md) の方針どおり sidecar に保存・再開しない。
- in-flight の conductor send、Driver の実行状態、send の再開位置は保存しない。再開は中断した send を継続・再実行する hot pause ではない（[ADR 0017](0017-conductor-send-lifecycle-events.md)）。
- sidecar はローカルの再開記録であり、別マシンへの持ち運びや remote worktree の保持は保証しない。backend が session を復元できない、または保存情報と起動時設定が整合しない場合の扱いは既存 resume 契約に従う。
- `/close` の process termination guarantee は、TTY が post-loop に残らず、close path が所有する monitor・ACP worker・conductor・Pi stdio MCP handle を teardown してプロセスを終えることを指す。終了 status code や sidecar flush 成功までは保証しない。

### 関連 ADR との境界

- **ADR 0013** の「自律ループ停止と process termination は別」という基礎判断は維持する。本 ADR は post-loop を通常どおり維持したまま選べる明示的な終了操作として `/close` を追加し、`/exit` と signal interruption との意図の違いを定義する。
- **ADR 0011** の sidecar schema、conductor / worker resume、permission 非永続、best-effort flush の判断は変更しない。本 ADR はそれらを利用して同じ Issue を続ける方法を定める。
- **ADR 0023** の「TTY 初回メッセージがあっても通常の post-loop 待機を維持する」判断は変えない。`/close` はその待機から明示的に終了する選択肢であり、非 TTY one-shot の終了契約も変更しない。
- **Issue #457** の一般的な `/exit` 後プロセス残留 remediation は別スコープのままとする。本 ADR で扱うのは `/close` 自身の終了契約に必要な resource teardown、特に Pi stdio MCP handle の解放だけである。

## Consequences

- オペレータは、再開を意図する一時退室には `/close`、cleanup を伴う終了には `/exit`、割り込みには Ctrl+C / SIGINT を選び分けられる。
- `/close` は process を終える一方、worktree と sidecar 上の再開情報を残すため、「TTY を閉じる」と「Issue 作業の状態を掃除する」を分離できる。
- worker prompt と pending permission は中断され、monitor 更新は再配送によって重複しうる。sidecar flush も best effort のため、`/close` は pause/resume と同等の無損失 checkpoint ではない。
- TTY process termination と Pi stdio MCP child の回収を close path の検証対象に含める。別経路全般の process leak 解消は #457 で扱う。
