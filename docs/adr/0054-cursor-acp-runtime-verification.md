# ADR 0054: Cursor ACP の未検証 runtime と resume metadata の扱い

- Status: accepted
- Date: 2026-11-05
- Related: [ADR 0048](0048-session-resume-feasibility-config-digest.md), [ADR 0052](0052-acp-model-injection-by-preset.md), [ADR 0053](0053-worker-acp-cursor-fast-option.md), [Issue #616](https://github.com/otolab/agents-ensemble/issues/616), [Issue #630](https://github.com/otolab/agents-ensemble/issues/630)

## Context

Cursor CLI の公式 parameter reference は `--model` を CLI の model selection option として掲載し、ACP docs は `agent acp` と認証手順を案内する。一方、これらは ACP response を runtime model の attestation と定めていない（[Cursor CLI parameters](https://prod.cursor.com/docs/cli/reference/parameters)、[Cursor ACP docs](https://prod.cursor.com/docs/cli/acp)）。

ACP の session config option にある `currentValue` は Agent が報告した session 設定値であり、実際に推論へ使われる model / variant の attestation ではない。ACP の仕様は session の option の取得・変更を定めるが、provider の実行経路までは規定しない（[ACP v1 session config options](https://agentclientprotocol.com/protocol/v1/session-config-options)）。

Cursor については次の根拠がある。

- forum #159748 の `agent --model` が reasoning suffix を落とす報告に対し、Cursor 担当者は 2026-08-27 に最新 CLI では suffix が適用されるはずとして再試行を依頼した。thread には再現結果がない（[forum #159748](https://forum.cursor.com/t/cursor-cli-agent-model-ignores-reasoning-thinking-level-suffix/159748)）。
- forum #174835 では `agent 2026.10.14-941492e` の ACP が non-Fast の要求を Fast と報告した。Cursor 担当者は、picker capability がないと model ごとの既定 variant が選ばれ、Grok 4.6 では実 request も Fast に送られる既知問題だと説明した。担当者は `parameterizedModelPicker` と `fast` / `effort` option を案内し、投稿者は ACP の `currentValue` が `fast=false` になることを確認したが、これは runtime model の確認ではない（[forum #174835](https://forum.cursor.com/t/cursor-cli-acp-reports-grok-4-6-fast-despite-explicitly-selecting-the-listed-non-fast-model/174835)）。
- 別の forum 報告は、ACP setter の成功応答や `currentValue` が要求どおりでも、Cursor session store の runtime slug が Fast variant や別 effort を示した例を記録している。作業環境の CLI `2026.11.05-86047df` では認証付き session を作れず、#159748 の再現も runtime model の照合も行えていない（[forum #165622](https://forum.cursor.com/t/document-and-stabilize-non-fast-model-selection-for-acp-stdio-sessions/165622)）。

resume については ADR 0048 / Issue #616 が、model / reasoning / env の変更を新しい `resume-feasibility` sidecar の拒否理由にしないと決めている。Issue #630 に当初記載された「model / reasoning の変更を config digest と worker `acpSpawn` fingerprint で検出する」という条件はこの合意と重なるため、オペレータの決定に従って「値を記録する」と「resume を拒否する」を分ける。Issue #630 の該当条件は #616 に合わせて見直す。

## Decision

- Cursor では公式 CLI の `agent --model <id> acp` に model-only の要求値を渡す。これは CLI への要求であり、ACP の報告値を含め、実際の runtime model を保証しない。
- Cursor で `reasoning` または `cursorFast` が明示された場合、runtime に届いたことを確認できる契約がないため worker spawn 前に fail fast する。`parameterizedModelPicker` や setter の応答だけを成功根拠にしない。
- `cursorFast` を省略した場合は initialize capability と `fast` setter を送らず、Cursor CLI が選ぶ既定 variant に任せる。model ID から Fast / non-Fast を推測しない。既定が何になるかは model と CLI に依存し得て、この作業環境では未検証である。#174835 は capability なしの Grok 4.6 の既定が Fast だった事例を示す。
- 新しい session は `acpModelConfigDigest` と worker spawn fingerprint に model-routing 情報を記録する。digest は merge 後の `acp.env` / `acp.models` / `acp.tags` を hash し、fingerprint は worker ごとの `modelTag` / model / reasoning / `cursorFast` / env digest と Codex の実効 `MODEL_PROVIDER` digest を保持する。秘密の環境値は平文で保存しない。これらの値は診断用であり、resume 判定には使わない。
- ADR 0048 の `resume-feasibility` digest は `session.worktree` と `acp.defaultPreset` を比較する。spawn fingerprint は preset を比較し、`custom` の場合だけ command / args も比較する。model / reasoning / env の差は拒否条件にしない。identity、conductor backend、MCP、worker cwd の既存検証は維持する。
- 旧 sidecar の scheme 省略 / `full` digest は、保存当時の全体 hash と現在の config を従来どおり比較するため、config に含まれる model / reasoning / env の変更でも拒否されることがある。既存 digest の意味は変えず、欠けた digest や fingerprint field はバックフィルしない。model config digest がない `resume-feasibility` store は warning を出すが、その欠如は拒否理由にしない。
- `claude-agent-acp` 0.70.0 と `pi-acp` 0.0.33 のテストでは固定版 adapter process を起動し、下位 SDK / Pi RPC のみを fake に置き換える。`session/new` と `session/load` 後に adapter が送る model / reasoning を確認し、外部 LLM request は行わない。

## Consequences

- Cursor で明示した reasoning / Fast 指定が検証不能なまま黙って通ることを防ぐ。model-only の `--model` も要求値の記録としてのみ扱い、利用者向け docs と `sessionModels` は runtime model を保証しないと明記する。
- `cursorFast` 省略時は従来の起動形を保つが、Cursor の既定 variant は保証しない。認証済み再現には、対象 model を利用できる Cursor account と専用の隔離環境が必要である。
- 新しい `resume-feasibility` sidecar は model / reasoning / ACP env の変更を harness 側で拒否しない。ACP 自身が `session/load` を受け付けない場合の扱いは接続経路に委ねる。
- 旧 session は保存済み情報が欠けていれば診断精度が下がる。warning を出す場合も、記録欠如と resume の可否を混同しない。新しい digest を補って過去の設定まで検証済みに見せることはしない。
