# ADR 0044: repo 単位のランタイム状態を user 層へ配置する

- Status: accepted
- Date: 2026-10-23

## Context

SessionResumeStore、Open Question / session-state sidecar、tool-call 履歴、operator-agent の watch 状態など、マシン単位のランタイム状態が project `.ensemble/` に保存されている。複数 repo を扱う operator-agent から参照しやすくし、project `.ensemble/` を team profile と repo 固有設定の置き場に保つには、ランタイム状態を user 層へ集約する必要がある。

保存先の識別には Git remote と正規化した `repoRoot` が考えられる。remote は clone 間で同じ値になり、別 checkout の状態を意図せず共有する。`repoRoot` は同一 checkout の位置に結びつき、既存 SessionResumeStore の repo 文脈とも一致する。

Issue 用 isolated worktree は `<repoRoot>/.ensemble/worktrees/issue-N` に作る。Git worktree は元 repo の管理情報に登録される。Git 自体は repo 外の配置も許すが、このリポジトリの作成・再利用・削除処理は `repoRoot` から `.ensemble/worktrees/issue-N` を導出する。user 層へ移すと worktree の解決契約も変わるため、本 Issue では既存の配置を保つ。

## Decision

- `packages/core` の `resolveEnsemblePaths({ repoRoot })` をランタイム・project `.ensemble/` の単一パス解決 API とする。
- `repoKey` は `resolve(repoRoot)` で得る正規化済み絶対パスの SHA-256 とする。異なる clone / checkout は別領域になる。同じ repoRoot を使う `--resume` / `--continue` / operator-agent は同じ領域を参照する。
- SessionResumeStore、Open Question / session-state YAML、tool-call snapshot 履歴は `~/.ensemble/sessions/<repoKey>/` に置く。Pi conductor transcript も同領域の `pi/` に置く。operator-agent 自身の状態・watch cursor・Pi transcript は `~/.ensemble/operator-agent/<repoKey>/` に置く。
- project `<repoRoot>/.ensemble/` には team profile、project config、Pi project resources を置ける。Pi の `sessions/` transcript は project resource ではないため user 層へ置く。
- isolated worktree は従来どおり `<repoRoot>/.ensemble/worktrees/issue-N` に置く。Git の登録情報が元 repo に結びつき、現行の worktree 解決処理もこの project-local path を導出するための例外である。`in_repo` は worktree を作らない。
- 旧 project `.ensemble/sessions/` と operator-agent / Pi の保存状態は読み取り fallback とし、読み込み後の更新は user 層へ書く。SessionResumeStore と sidecar は resume 時、Pi transcript は session 再開時、operator-agent state はロード時に user 層へ移す。旧ファイルの一括削除は行わない。

## Consequences

- 同一 checkout 内では既存の issue URL / `repoRoot` 照合を保ったまま user 層へ保存できる。repo の移動や別 clone では新しい repoKey となり、以前の状態を自動では引き継がない。
- project `.ensemble/` は team profile と repo 固有設定を中心に保てる。Git worktree と設定・Pi project resources は project 層に残る。
- 旧保存先からの移行は利用時に進む。使われない古いファイルは残る。
- `~/.ensemble/` の任意変更（XDG / `ENSEMBLE_HOME`）は別途扱う。

## 関連

- [ADR 0018](0018-team-profile-four-layer-resolution.md) — project / user team profile の配置と解決
- [session-logging.md](../session-logging.md) — 現行の保存先と resume の説明
- [Issue #585](https://github.com/otolab/agents-ensemble/issues/585)
