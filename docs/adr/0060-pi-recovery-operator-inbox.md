# ADR 0060: Pi 失敗 dispatch の operator 専用 inbox

- Status: superseded by [0066](0066-conductor-dispatch-lifecycle-and-recovery-boundary.md)
- Date: 2026-11-10
- Related: [Issue #650](https://github.com/otolab/agents-ensemble/issues/650#issuecomment-6762502118), [PR #651](https://github.com/otolab/agents-ensemble/pull/651), supersedes [ADR 0059](0059-pi-recovery-report-after-manual-reconnect.md)

## Context

ADR 0059 の recovery report は失敗 dispatch の識別情報だけを conductor に渡す。`sendCount`、`runId`、source、event index は task 本文の lookup key ではなく、Pi transcript に operator message や worker result が残る保証もない。そのため report だけでは、後から内容を確認して新しい指示を作ることができない場合がある。

最終 Pi API-key resolver failure を処理する driver には、実際に送った元 `SessionEvent[]` が残っている。この本文を process memory に置けば、transcript を参照できない場合にも同一 session の operator が確認できる。一方、自由文や permission の raw payload は secret を含み得て、一般的な secret redaction はない。本文を conductor の report に自動同梱すると、通常の tool-enabled send で失敗 input の再実行を誘発し得る。

検討した選択肢:

1. **識別情報だけを残す** — leak と重複実行は抑えられるが、元 event 本文が transcript にない場合は operator が内容を確認できない。
2. **本文を recovery report に含める** — conductor には文脈を渡せるが、secret を再提示し、tool / worker の副作用を重ねる可能性がある。send 単位の tool 無効化や effect dedupe はない。
3. **process-local inbox に本文を分離し、operator が明示表示する** — 同一 process 中の確認を可能にし、失敗 batch を conductor に再送しない。TTY の表示漏えいと process 終了後の消失は残る。
4. **暗号化した永続 inbox を導入する** — restart 後の保持に近づくが、disk 上の secret 保護、stable event identity、atomic な保存・send 境界、削除、side effect dedupe の設計が必要で、この Issue の範囲を超える。

## Decision

- 最終的な Pi API-key resolver failure で通常 dispatch が失敗した場合にだけ、元 batch の formatted conductor input を operator-only snapshot として保持する。自動 retry の途中では作らず、synthetic `conductor.recovery.report` 自身の本文も snapshot に加えない。failure report candidate は従来どおり metadata-only とし、snapshot と独立した寿命にする。
- snapshot は元の dispatch 全体を保持する。operator message や worker result に限らず、対象 batch に含まれる permission raw payload、GitHub update なども含み得る。secret redaction は行わない。terminal control と bidi 制御文字は表示時に可視表記へ変換する。
- `/recovery list` は本文を表示せず summary metadata を返す。`/recovery show <recoveryId>` だけが本文を取得し、CLI は対話 TTY 上の local operator input からのみ表示する。これらの command は operator binding 内で完結し、`SessionEventQueue`、conductor、UDS、SessionLogEvent へ送らない。snapshot API は同一 process の operator binding に限り、operator-agent の UDS API には公開しない。
- `/recovery hide` / TUI の Escape は表示を閉じる。`/recovery clear <recoveryId>` は inbox からその snapshot の参照を外すが、pending metadata-only report candidate は取り消さない。JavaScript runtime 上の memory zeroization は保証しない。readline 経路で一度表示した terminal scrollback も消去できない。
- 保持上限は session ごとに最大4 dispatch、failure 時刻から30分とする。5件目では最古を FIFO で削除し、ID だけの warning を出す。本文は切り詰めないため、単一 dispatch の byte ceiling は設けない。event payload の byte 上限がない現在、件数と寿命は制限できても、snapshot の最大 memory 使用量は保証できない。厳密な byte ceiling を追加する場合、全内容保持と両立させるには入力 admission/back-pressure か、上限超過時の明示的な不保存方針が別途必要となる。
- Inbox は conductor recovery report や event queue と別の状態である。後続 send が始まれば古い report candidate は失効し得るが、snapshot は明示削除・TTL・FIFO eviction・session teardown まで一覧 / 表示できる。reconnect await 中の通常入力の queue 順は変えず、snapshot command 自体は queue に入れない。
- `show` は確認専用で、再送・再実行を提供しない。operator は現行 worker / worktree 状態と既に起きた副作用を確認し、確認できた未完了分だけを新しい operator message として指示する。元本文をそのまま再入力すると副作用を重ねる可能性がある。`toolCallStarted: false` は callback を観測しなかったという意味で、副作用がなかった証拠ではない。
- Snapshot 本文を持つ `SessionLogEvent` / activity log / SessionResumeStore field / exit-summary field / UDS response は追加しない。failure の `harness.warning` は ID / expiry / eviction ID のみを含む。ただし、既存の `operator.input` / `operator.dispatched` は本文を live sink に渡し、既存の worker result は `worker.round` / session summary に含まれ得る。TTY で明示表示した内容は画面共有・端末録画・capture から保護されない。
- `/close`、`/exit`、Ctrl+C、process crash では snapshot を永続化せず破棄する。`--continue` / `--resume` で復元しない。Pi transcript に元 input が残ることも保証しない。

## Consequences

- transcript に元入力がなくても、同じ session process が動いている間は operator が失敗 dispatch を確認できる。内容は tool-enabled conductor send に再投入されず、再指示は operator が現在状態を確認した後に行う。
- 最大4件・30分の保持は同時に起きる複数の failure に対応するが、本文 size が無制限なので memory の絶対上限ではない。大きな dispatch は process memory を大きく消費し得る。
- `show` の TTY gate は通常 CLI の表示面を制限するもので、端末利用者の本人確認、screen recording 防止、同一 OS user 内の process 分離ではない。in-process operator binding は信頼されたコードとして扱う。
- `clear` / expiry / teardown は store の参照を落とす。runtime が残存 string をいつ回収するか、provider 側 transcript が何を保持するかは保証しない。
- process 終了後の recovery を要求する場合は、secret を含む payload の保護と、stable identity、atomic commit / acknowledgement、tool effect dedupe を含む別 ADR が必要となる。
