# ADR 0031: tool-call snapshot 履歴の永続化

- Status: accepted
- Date: 2026-10-20
- Related: [ADR 0011](0011-session-sidecar-resume.md), [Issue #478](https://github.com/otolab/agents-ensemble/issues/478)

## Context

`tool_call` / `tool_call_update` から作る累積 snapshot は conductor session のメモリだけにあり、
`--continue` / `--resume` 後に permission brief の補完や `get_tool_call` に使えない。

既存 session sidecar は必須の resume 状態を検証する厳格な JSON 形式であり、sidecar 本体に追加すると
履歴だけの破損が session resume 全体を妨げる。また、runtime `workerId` は worker 登録時に生成される UUID で、
再起動後は同じ worker でも変わる。

## Decision

- snapshot 履歴は `.ensemble/sessions/{conductorAgentId}.tool-calls` に独立した JSON ファイルとして保存する。
  `.json` 拡張子を避け、session sidecar の列挙対象に混ぜない。更新は temp file から rename する。
- 保存単位は `(workerId, ACP sessionId, toolCallId)` の累積 snapshot とする。再結合用に stable な `workerName` と
  最終更新時刻も保存する。resume 時は worker 名を現在の runtime `workerId` に結び直し、ACP `sessionId` は維持する。
- tool-call 更新は 100 ms でまとめて best-effort flush し、teardown 中は worker 停止後にも flush する。
- 履歴は最終更新から 30 日で期限切れとする。1 session あたり最大 1,000 snapshot、合計 8 MiB とし、
  上限を超えた場合は古い snapshot を丸ごと削除する。新しい 1 snapshot だけでサイズ上限を超える場合は保存しない。
  snapshot の内容を部分的に切り詰めない。inactive な履歴ファイルは session 起動時に 30 日を過ぎていれば削除し、
  読み込み時・新しい更新時にも期限切れ entry を除く。履歴が空になったファイルは削除し、
  30 日以上残った atomic write 用一時ファイルも起動時に削除する。
- 履歴ファイルが無い場合は空の履歴として扱う。不正な envelope / JSON は破棄し、不正な個別 entry は読み飛ばす。
  読み込み失敗は warning を出して履歴なしで続行する。履歴の問題を理由に resume を失敗させない。
- 履歴はローカルに平文で保存され、path / command / tool input 等を含み得る。gitignore 対象とし、Issue / PR /
  SessionSummary へは含めない。permission brief と `get_tool_call` から conductor に渡した内容は、
  選択中 backend の会話へ含まれる場合がある。

## Consequences

- 良い: sidecar の必須 resume 契約と独立したまま、保存済み tool-call を permission 判断と lookup に再利用できる。
- 良い: worker UUID の再生成後も worker 名と ACP session scope に基づいて履歴を戻せる。
- 悪い: crash 時は最後の flush 以降の更新が失われる。サイズ上限を超える snapshot は取得できない。
- 悪い: path / command / input を含む平文がローカルに最大 30 日残る。利用者は `.tool-calls` ファイルを削除して早期削除できる。
