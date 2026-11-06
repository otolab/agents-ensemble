# ADR 0051: conductor reasoning と resume-feasibility digest

- Status: accepted
- Date: 2026-11-05
- Related: [ADR 0048](0048-session-resume-feasibility-config-digest.md), [ADR 0049](0049-conductor-reasoning-backends.md), [ADR 0050](0050-operator-agent-conductor-reasoning.md), [Issue #629](https://github.com/otolab/agents-ensemble/issues/629)

## Context

ADR 0048 は、再接続の可否に関わる `session.worktree` と `acp.defaultPreset` だけを新しい `resume-feasibility` digest に含め、model のような実行時の選好は neutral とする。Issue #629 で追加する `conductor.reasoning` も model の実行時設定であり、同じ config 変更だけを理由に session の再接続を拒否する必要はない。

Issue #629 の当初の受け入れ条件は、reasoning の config 変更を全体 digest で検出する内容だった。operator は Open Question `inq-1` で、main の resume-feasibility 方針を優先し、`conductor.model` と同じく新規 session では reasoning の変更で resume を拒否しないと決定した。一方、旧 sidecar の `full` digest は当時の全体比較を維持する必要がある。

## Decision

- `conductor.reasoning` を `resume-feasibility` digest の neutral config key に分類する。新しい Issue session では config の reasoning が変わっても resume を拒否せず、resume 時に解決した現在の値を backend に渡す。
- Issue 起動の `--reasoning` / `CONDUCTOR_REASONING` は config digest に含めず、各 invocation で再解決する。operator-agent は共通 config / `CONDUCTOR_REASONING` を使い、専用 CLI option は追加しない。
- scheme のない旧 sidecar と `full` sidecar は従来どおり merged `EnsembleConfig` 全体を比較する。reasoning の config 値が変われば resume を拒否する場合がある。旧 scheme や digest を新方式へ自動変換しない。

## Consequences

- 新しい session は model と同じく reasoning の変更を許容して再接続でき、現在の config / env の値を次の conductor 起動へ適用する。
- 旧 `full` sidecar は保存時の整合性契約を保つ。neutral な設定変更により digest が変わった場合は自動移行せず、新しい session を開始する。
- ADR 0048 の digest scheme と critical key は維持し、`conductor.reasoning` の分類だけを本 ADR で補う。
