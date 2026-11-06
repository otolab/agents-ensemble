# ADR 0050: worker ACP の Cursor fast mode を明示設定する

- Status: superseded by [0051](0051-cursor-acp-runtime-verification.md)（Cursor の option 適用方針を更新。明示した `reasoning` / `cursorFast` は fail fast、model-only は CLI への要求として扱う）
- Date: 2026-11-05
- Related: [ADR 0049](0049-acp-model-injection-by-preset.md), [Issue #630](https://github.com/otolab/agents-ensemble/issues/630)

## Context

ADR 0049 は Cursor の Fast / non-Fast を model ID 側で選ぶ判断をした。その後の Cursor forum #174835 では、non-Fast の model ID を `agent acp` に渡しても ACP session の `fast` option が有効になる事例に対し、Cursor 担当者が `initialize.clientCapabilities._meta.parameterizedModelPicker: true` と `fast=false` / `effort=high` の指定を案内し、投稿者が直接 ACP 接続で確認している。これは `reasoning` を表す `effort` と Fast mode が別々に設定できる根拠になる。

この作業環境には Cursor CLI（`2026.11.05-86047df`）があり、`agent acp --help` も確認できた。一方、forum #159748 の suffix 報告を含む認証付き session の再現には `cursor_login` と利用可能な model が必要で、この環境では実施できない。forum #174835 の直接接続による報告は upstream の実証として扱うが、local での再現や実際の推論先までは確認済みとしない。

## Decision

- `acp.models` の構造化 entry に Cursor 専用の `cursorFast?: boolean` を追加する。既存の model ID shorthand と `reasoning` の意味は変えない。
- Cursor preset では model ID を従来どおり `agent --model <id> acp` に渡し、`parameterizedModelPicker: true` を送る。`reasoning` は ACP の `effort` option、`cursorFast` は独立した `fast` option に `true` / `false` の文字列で渡す。
- `cursorFast` を省略したときは Cursor の既定選択に委ねる。model ID から Fast / non-Fast を推測しない。
- Cursor 以外の preset に `cursorFast` が指定された場合は spawn 前にエラーにする。`custom` command には一般化できる注入契約がないため、model catalog の解決自体を fail fast とし、独自設定は既存の `acp.env` に委ねる。
- attach と resume の両方で、ACP が対象 option と値を広告していること、および設定後の `currentValue` が要求値と一致することを最初の prompt より前に確認する。不在・候補不一致・setter error・読み戻し不一致は attach error とする。
- `cursorFast` は model-routing digest、ACP spawn fingerprint、session resume store と終了時の `sessionModels` に記録する。`false` は明示値として保持するが、resume 拒否判定には使わない。Cursor runtime の検証可能性と明示値の扱いは [ADR 0051](0051-cursor-acp-runtime-verification.md) を参照する。

## Consequences

- model ID、推論 effort、Fast mode を別々に設定できる。利用者が `cursorFast: false` を指定すれば、model ID の suffix や Cursor の既定状態に判断を委ねず non-Fast を要求できる。
- ACP の `currentValue` は session 設定の読み戻しを示すもので、実際の backend がどの推論経路を使ったかを保証しない。終了サマリと文書では両者を混同しない。
- repository の protocol fake は harness の option 送信、fail fast、resume 整合性を検証する。認証付き Cursor session はこの作業環境では未検証のため、option が広告されない、または要求値が読み戻されない場合は成功扱いしない。
