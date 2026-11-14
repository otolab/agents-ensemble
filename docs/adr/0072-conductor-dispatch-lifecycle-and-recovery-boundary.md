# ADR 0072: conductor dispatch lifecycle と recovery 境界

- Status: accepted
- Date: 2026-11-12
- Related: [Issue #668](https://github.com/otolab/agents-ensemble/issues/668), supersedes [ADR 0059](0059-pi-recovery-report-after-manual-reconnect.md) and [ADR 0060](0060-pi-recovery-operator-inbox.md)

## Context

ADR 0060 は Pi の API-key resolver failure に限り、失敗した dispatch 本文全体を operator-only inbox に保存し、手動 reconnect 後に model-facing recovery report を送る判断を記録した。その後の調査では、認証以外の失敗でも send の受理・実行結果が曖昧になり、`toolCallStarted` がなかったことも副作用不存在の証明にはならないと分かった。また Issue workflow と operator-agent は異なる queue、selector、優先順位、hold、watch report の retry 契約を持つため、inbox だけを共通化しても失敗後の選択・消費・再開の境界は揃わない。

本文の完全保持と任意サイズ入力の無制限 dispatch は、有限の byte 上限と両立しない。失敗後に本文を切り詰めたり古い snapshot を黙って削除したりすれば、確認用の記録として不完全になる。さらに、一時ファイルへの保存だけでは queue の消費・provider の受理・tool の副作用を原子的に確定できない。本文 hash による重複抑止も、同じ文章を別の意図で再入力したケースを区別できず、副作用の重複を防ぐ契約にはならない。

## Decision

- 共通 `ConductorDispatchLifecycle` は、一度に一つの send または reconnect を所有する lease、availability、settle、未確定 send 後の operator confirmation gate を管理する。Issue の `SessionEventQueue` / selector と operator-agent の `OperatorDispatchQueue` / selector は分けたまま、優先順位・batching・hold・watch report の ack / retry 契約を維持する。lease は一つの in-flight attempt の所有権であり、第2の scheduling queue ではない。
- send 結果が `finished` / `completed` にならなければ、失敗した operator input を通常 dispatch queue に戻さない。auth / transport error では従来の範囲で同一 agent ID の reconnect を一度試すが、同じ prompt は自動再送しない。`send()` の reject は結果不明として扱い、raw error を recovery data に残さず agent を unavailable にする。reconnect 失敗後は通常 dispatch を止め、明示的な `/reconnect` を待つ。後続入力は失敗の確認が済むまで送らず、operator が `/recovery continue` を実行した後に再開する。
- recovery inbox には、実際に dispatch した batch に含まれる operator-authored input だけを保持する。Issue の初回 `initialPrompt`（Cursor の compiled system prompt、Pi の kickoff）や compiled prompt 全体、worker result、permission raw payload、GitHub update、raw error は含めない。Issue の初回 CLI / environment message は別の `operator.message` として queue に入り、dispatch されたときだけ対象になる。operator-agent の初回 send も、選択された user input の本文だけを対象にする。
- inbox は process-local とし、snapshot を確認できるのは stdin / stdout / stderr がすべて TTY の対話実行に限る。非 TTY では失敗本文を保存・表示せず、同一 process 内でも確認できないことを本文なしで通知する。TTY での `show` は operator の明示操作に限り、terminal control / bidi 制御文字を可視化する。screen recording、terminal capture、画面共有からの秘匿は保証しない。
- admission は send 前に行う。operator-authored input は UTF-8 で1 dispatch あたり最大1 MiB、inbox は最大4 snapshot・合計4 MiB・failure から30分とする。単体上限を超える入力は enqueue 前に拒否して短縮・分割を案内する。workflow selector は同一 source の operator batch を1 MiB以内に分け、到着順を保つ。send 前に snapshot 数と byte 数を予約し、容量が足りなければ選択 input を通常 queue に残して待つ。TTY operator は `/recovery clear <id>` または TTL 経過で容量を空けられる。失敗後の FIFO eviction と本文の切り詰めは行わない。byte budget は recovery 用の operator input copy に適用し、既存 queue や任意の process memory 全体を上限化するものではない。
- `show` は確認だけを行い、send / replay を起こさない。operator は現在の worker / worktree 状態と副作用を確かめ、必要なら未完了分だけを新しい入力として渡す。`/recovery continue` は後続 queue の再開確認であり、失敗した input の再送ではない。`/reconnect` は agent の接続回復だけを行う。
- Issue workflow の `conductor.recovery.report` は built-in recovery path で送らない。代わりに model や tool を実行しない local `harness.warning` を出す。公開 event type と formatter は既存利用者との互換性のため残すが、新しい recovery attempt には生成しない。
- 旧 `PiAuthRecoverySnapshotStore` API は source compatibility のため残すが、組み込み workflow からは生成・利用しない。実際の recovery state は共通 inbox だけが保持する。
- operator-agent の watch report は従来の pending report ID による at-least-once retry を維持し、user input とは混ぜない。report retry は内容 dedupe や downstream tool effect の idempotency を意味しない。user input の失敗は inbox と confirmation gate で扱う。
- recovery snapshot 本文を新しい SessionLogEvent、終了 summary、SessionResumeStore、UDS response、conductor send に複製しない。既存の `operator.input` / `operator.dispatched` / `worker.round` の出力・保存契約は変更せず、inbox の追加コピーとは区別する。process 終了時に inbox と通常 queue は破棄し、resume 後の復元・自動 replay は行わない。
- 一時ファイル、独立した第2 queue、本文 hash / 内容 dedupe は導入しない。process 間 replay が必要なら stable event identity、atomic な送受信境界、受け手側の副作用 idempotency を別設計で扱う。

## Consequences

- 2つの workflow 固有 selector と運用規則を保ちながら、単一 in-flight の所有権と失敗後の状態遷移を共通の lifecycle に集約できる。失敗 input が後続 dispatch に紛れて再送される経路と、再接続に失敗した closed handle への送信を防ぐ。
- operator は曖昧な send の後に状態を確認し、後続作業を明示的に再開する必要がある。watch report は at-least-once のため、send 結果と ack 永続化の境界で重複する可能性は残る。
- recovery 内容を確認できるのは対話 TTY の実行中だけである。非 TTY の利用者は同一 process 内でも本文を確認できず、その旨の通知を受ける。4 MiB の上限と事前 admission により全内容を保持するが、容量待ち中は operator input の dispatch が止まる。
- snapshot は secret を含む可能性があり、TTY 表示や通常の operator input log を保護しない。TTL / clear / teardown は参照を外すだけで、JavaScript memory の zeroization を保証しない。
- byte limit は inbox が保持する operator-authored text を制限する。既存 dispatch queue、provider transcript、通常ログ、worker payload を含む process memory 全体の上限ではない。
