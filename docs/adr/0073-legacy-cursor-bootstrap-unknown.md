# ADR 0073: 旧 Cursor bootstrap 状態を unknown として再開する

- Status: accepted
- Date: 2026-11-12
- Related: [Issue #668](https://github.com/otolab/agents-ensemble/issues/668), [PR #677](https://github.com/otolab/agents-ensemble/pull/677), [ADR 0072](0072-conductor-dispatch-lifecycle-and-recovery-boundary.md)

## Context

`cursorBootstrapComplete` のない旧 SessionResumeStore では、compiled prompt が Cursor provider に届いたか分からない。旧実装の `cursorBootstrapRunId` は initial send の結果にかかわらず記録され得るため、この ID から完了を推定できない。欠落を完了扱いにすれば文脈のない dispatch が起きる可能性があり、自動で未完了扱いにすれば provider transcript に prompt が重複する可能性がある。

## Decision

- field 欠落は `unknown` とし、`cursorBootstrapRunId` から成否を推測しない。
- 対話 TTY では operator へ個別の警告と選択肢を示す。`/recovery bootstrap assume-complete` または `/recovery bootstrap assume-incomplete` の選択を SessionResumeStore に保存するまで、初回を含む event dispatch を止める。
- `assume-complete` は prompt を追加送信しない。旧 provider session に文脈がなかった可能性は残る。
- `assume-incomplete` は次に selector が選んだ新しい event に compiled prompt を添える。選択済みだった失敗 input は再投入しない。prompt の受理結果が曖昧なら、provider transcript に同じ prompt が重複する可能性は残る。
- 保存に失敗した選択は反映せず、状態を `unknown` に戻して dispatch を止める。
- 判断を入力できる対話 TTY binding がない場合、`--continue` は backend resume 前に案内付きで停止する。boolean が保存された後は通常の `--continue` で復元する。
- operator が選んだ boolean 以外の状態や queue は永続化しない。process 間の queue 復旧と failed input の自動 replay は対象外とする。

## Consequences

- 旧 Store を利用者の明示判断を挟んで再開でき、どちらの選択も黙って適用しない。選択は prompt 本文を保存せず boolean として残る。
- 非 TTY からの旧 Cursor session 再開は対話 TTY で一度判断するまで停止する。
- `assume-complete` では文脈欠落、`assume-incomplete` では provider transcript 内の prompt 重複の可能性を受け入れる。いずれも失敗 input の再送や process 間復旧は保証しない。
