# ADR 0046: 移行済みセッションの canonical slug mirror

- Status: accepted
- Date: 2026-11-02
- Related: [ADR 0044](0044-user-scoped-runtime-storage.md), [Issue #607](https://github.com/otolab/agents-ensemble/issues/607)

## Context

ADR 0044 は repo checkout の SHA-256 path-hash を user 層ランタイム状態の通常保存先とする。project `.ensemble/` の状態をこの領域へ移すスクリプトも path-hash を移行先にする。

一方、GitHub repo slug と path-hash の両方に同じ SessionResumeStore が残ると、operator が古い hash copy を選び、稼働中 harness の `harnessSocketPath` を見失うことがある。path-hash だけを作る移行では hash-only のままになり、slug 優先規則を適用できない。hash 側を削除・退避せず、この状態を避ける必要がある。

## Decision

- path-hash は新規 session の通常保存先として維持する。
- project runtime の一括移行では、SessionResumeStore を path-hash へ移した後、valid な GitHub Issue URL と一致する canonical slug 側に JSON と対応する Open Questions / session-state YAML を、宛先が未作成の場合だけ複製する。すでに hash 側へ移行済みの状態に対して同スクリプトを再実行した場合も、この mirror を作成する。
- 移行で slug mirror が作られた session は slug 側を正本とし、resume 後の SessionResumeStore と sidecar の更新も slug 側へ続ける。別の session は従来どおり path-hash を使う。
- path-hash 側の JSON / YAML は削除・退避・上書きしない。既存 slug 側のファイルも移行処理では上書きしない。
- operator は選択された ResumeStore location に沿って sidecar を読む。slug は slug → path-hash → project legacy、hash は hash → project legacy、project legacy は project legacy のみを探索する。
- operator-agent の repo 単位 state は、選択済み ResumeStore が一意の canonical slug に揃う場合に限り slug-keyed path を使う。hash-only / project legacy / 複数 slug の場合は path-hash を使い、旧 path から読み込んだ state は選択先へ複製する。

## Consequences

- hash-only のまま移行が終わることを防ぎ、同一 session の live UDS endpoint と YAML snapshot を slug 側から一貫して選べる。
- path-hash の通常保存方針は維持されるが、明示的な移行を通った session には slug 正本の例外が生じる。
- hash copy は保全されるため、移行は非破壊で再実行できる。slug 側の既存データを自動統合することはせず、既存 slug を優先する。
- operator-agent の repo state は全 session が一意の slug に揃わない間は path-hash に留まる。複数の repo slug が同じ checkout に残る場合、slug 間の state 自動統合は行わない。
