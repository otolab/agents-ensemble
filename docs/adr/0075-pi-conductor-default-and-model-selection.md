# ADR 0075: Pi conductor を既定にし、model 選択を Pi settings に委ねる

- Status: accepted
- Date: 2026-11-14
- Related: [Issue #684](https://github.com/otolab/agents-ensemble/issues/684), [Phase A PR #689](https://github.com/otolab/agents-ensemble/pull/689)

## Context

Phase A は `ensemble setup` を追加し、conductor backend、Pi の provider / model、認証を user 層へ保存する初回導線を用意した。Phase B では backend 未指定時の既定を Pi にする。一方、コード既定の `conductor.model` は従来から `default` であり、これをそのまま Pi に渡すと Pi が有効な model ID として誤解しないか、また provider / model をどこから選ぶかを固定する必要がある。

Pi 1.2.0 の conductor adapter は `default` / `auto` を model 指定なしとして正規化し、Pi resource settings の `defaultModel` と `defaultProvider` から選択する。これらがなく、明示 model もない場合は Pi session 作成前に設定方法を示すエラーになる。`ensemble setup` は user Pi settings と認証をまとめて用意するため、clone 後の推奨初回導線と整合する。

## Decision

- `conductor.backend` を省略した場合は `pi` を選ぶ。Cursor SDK は config または profile に `backend: cursor` を指定して使う。
- `conductor.model: default` は backend-neutral な選択委譲値として維持する。Pi では `settings.json` の `defaultProvider` / `defaultModel`（実装が扱う `model` / `modelId` alias を含む）を利用し、CLI / API / 環境変数 / config の明示 model があれば既存の優先順に従う。
- Pi settings に既定 model がなく、明示 model もない場合は自動で provider や model を固定せず、Pi の fail-fast 設定エラーを利用する。初回利用では `ensemble setup` を推奨する。
- `acp.defaultPreset: cursor` は変更しない。worker ACP preset と認証は conductor backend 選択から独立し、各 worker runtime に委ねる。

## Consequences

- config をまだ作っていない利用者も、`ensemble setup` で選んだ Pi model と認証を使って起動できる。
- setup を実行せず Pi settings / 明示 model も用意していない場合、起動は model を推測せず設定エラーで止まる。
- 既定 conductor が変わっても worker は既定の Cursor ACP を維持する。Cursor conductor を使う利用者は backend を明示する必要がある。
