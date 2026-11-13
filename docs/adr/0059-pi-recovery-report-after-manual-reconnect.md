# ADR 0059: Pi 手動再接続後の recovery report

- Status: superseded by [0062](0062-conductor-dispatch-lifecycle-and-recovery-boundary.md)
- Date: 2026-11-10
- Related: [Issue #650](https://github.com/otolab/agents-ensemble/issues/650), [PR #651](https://github.com/otolab/agents-ensemble/pull/651), [ADR 0014](0014-conductor-dispatch-batch-coalescing.md), [ADR 0017](0017-conductor-send-lifecycle-events.md), [ADR 0030](0030-tty-close-lifecycle.md), supersedes [ADR 0058](0058-pi-send-recovery-replay-boundary.md)

## Context

Pi は同じ `send` の中で後続 model request の前にも API key を解決する。したがって、最終結果が API key resolver failure でも、それ以前の model / tool round が副作用を起こしていないとは限らない。同じ prompt を再送すると worker dispatch などを重複させる可能性がある。

ADR 0058 は、tool 開始を観測していない Pi resolver failure に限って手動 `/reconnect` 後に元 event batch を再キューする設計を採用した。その後のレビューでは、後続 operator send が始まった後や reconnect の await 中に入力が届いた場合に、古い batch が後から選ばれ得る順序上の穴が確認された。batch の queue 移動と候補の失効を複数箇所で同期させるより、失敗 event を再投入しない方が安全である。

また、`SessionEventQueue` と処理中 batch は SessionResumeStore に保存されず、Pi transcript に元入力が残ることも保証されていない。元 event の本文を recovery state として保存するには privacy、stable identity、送信と保存の atomic 境界、副作用の重複排除が必要となる。これは既存 in-process recovery の範囲を広げる。

検討した選択肢:

1. **失敗 batch を再キューする** — 修復後に自動で同じ work を進められるが、tool の部分実行と、後続入力後の古い event 再 dispatch を安全に扱えない。
2. **固定の operator message を注入する** — dispatch を再開できるが、新しい作業指示と recovery context の区別が曖昧になり、元 event の所在も伝わらない。
3. **失敗を識別する one-shot report を次の dispatch にまとめる** — 元 event を再送せず、失敗の所在と安全境界を conductor に渡せる。report の送信結果は不確実で、完全な task 本文の復元を保証しない。
4. **queue / event payload を永続化して replay する** — restart 後の継続を目指せるが、durable identity、atomic send commit、tool effect dedupe を新たに設計する必要がある。

## Decision

- **自動 send retry と手動 recovery を分ける。** auth / transport error 後の send 内自動経路は同じ agent ID を resume する。tool 開始通知が一度もない場合だけ同一 prompt を 1 回再送し、初回または retry のどちらかで tool が始まれば再送しない。この retry は手動 `/reconnect` の後処理ではない。
- **`ensemble issue` の手動 `/reconnect` では失敗 batch を再キューしない。** 最終結果が Pi API key resolver failure の場合にだけ、一つの in-memory candidate を作る。candidate は次の情報を保持する。
  - harness `sendCount`、Pi `runId`、dispatch `sourceKey`
  - event type / count と安全な event 参照（最大20件。各参照は failed dispatch 内の 1-based `eventIndex` を持ち、超過時は `eventReferencesTruncated` を立てる）
  - send 内の自動 retry 回数、tool call 開始有無
  - recovery を照合するための `recoveryId`
- candidate / report には認証 error 本文、API key、shell command / path、operator message 本文、worker prompt / 結果、permission raw payload を含めない。event に共通の stable ID は存在しないため、`sendCount` / `runId` / `sourceKey` / `eventIndex` と安全な参照は dispatch 内の照合情報であり、元の作業内容を再構成するものではない。
- 手動 reconnect 成功時に candidate を一回限りの `conductor.recovery.report` に昇格させる。reconnect 中に到着した event は `SessionEventQueue` に到着順で残し、復帰後に選択される次の dispatch の先頭へ report を加える。dispatch 可能な入力がない場合は report 単独を一回だけ dispatch する。失敗 batch の payload は再投入しない。
- report は send 開始時に消費し、その send が失敗しても別の遅れた通知として再投入しない。report を含む send には通常の send 内自動 retry が適用されるが、tool 未開始の場合の一回に限る。新しい実入力を含む send が最終 Pi resolver failure で終わった場合だけ、その最新 dispatch の candidate を作る。
- 手動 reconnect の resume が失敗した場合、今回の reconnect control は消費するが candidate と通常 input は process 内に保持する。旧 agent は closed / unavailable とし、通常 input は dispatch せず queue に保持して次の `operator.reconnect` を待つ。close 済みの handle を再度 close せず、同じ ID の resume を再試行する。reconnect await 中の input は queue に保たれ、成功後に report と同じ次の dispatch へ進む。再接続中に重ねて queue された reconnect は成功時にまとめ、失敗時は次回の resume 試行として一度にまとめる。
- report は dispatch hold を解除せず、hold 中の単独 dispatch を起こさない。既存規則で dispatch 可能な input と同じ束になる場合は report を加える。hold 解除後は max-turns で待機中の held worker event が残っていても report 単独 dispatch を許す。max-turns 到達後の report 単独 dispatch は有限の回復通知として許すが、自律 turn 数は変えない。この send でも model が tool を呼ぶ可能性はあるため、report は失敗した入力や曖昧な tool の再実行を指示せず、状況確認と operator への確認を促す。worker event は通常の max-turns 判定を受け、operator message が同梱される場合は既存どおり turn 数を reset する。
- `ensemble operator-agent` の手動 `/reconnect` は agent の close / resume だけを行い、失敗 prompt を再送せず、Issue session 向け recovery report も注入しない。
- candidate / report / `SessionEventQueue` は process 内だけに置き、SessionResumeStore には保存しない。`/close`、Ctrl+C、process restart をまたぐ replay は保証しない。Pi transcript に元入力が残る保証も置かない。report は conductor に event の所在と現在状態の確認を伝え、task 本文や tool 副作用を特定できない場合は operator に確認させる。report の send failure または shutdown 前の未送信時に、conductor への到達は保証しない。
- shutdown signal が manual reconnect の await 中に立った場合、その await が戻った後に queue / report を dispatch しない。resume API 自体は AbortSignal で中断できないため、await が戻るまで driver の終了が遅れる可能性がある。

## Consequences

- 元 batch を戻さないため、後続 input の後に古い worker event を再 dispatch する経路と、tool 実行済み batch の明示 replay をなくせる。reconnect await 中の入力は通常 queue の順序を保ったまま report と同じ send にまとまる。
- 同じ reconnect 処理中に届いた重複 `/reconnect` は、成功時の二重 resume を避け、失敗時も次の一回の再試行にまとめる。
- 手動 reconnect 後に送るのは状況 report であり、元の指示を復元・実行するものではない。context が不足した場合は operator の入力を待つ。これは自動で failed work を続けるより人手を要するが、部分実行を推測して重複させない。
- report は at-most-once の in-process context であり、send failure や process shutdown の後に届く保証はない。report 送信が失敗した場合は既存 send error / auth hint を確認して operator が新しい入力を出す。
- max-turns 到達後の report は自律ターン数に加算しない一回限りの例外だが、単一の conductor send 内で model が tool を呼ばないことまでは harness が保証しない。report の文面では失敗 batch / 曖昧な tool の再実行を禁じ、状態や operator の意図が特定できない場合は operator に確認する。
- restart 後の durable recovery が必要なら、stable event identity、payload privacy、send outcome の atomic commit、tool side effect dedupe を含む別 ADR で設計する。
