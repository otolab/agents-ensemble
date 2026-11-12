# ADR 0063: Builtin Pi の shell home と resume 失敗時の安全性

- Status: accepted
- Date: 2026-11-12
- Related: [ADR 0062](0062-pi-acp-upstream-package-wrapper.md), [Issue #670](https://github.com/otolab/agents-ensemble/issues/670)

## Context

upstream `pi-acp@0.0.34` は ACP process の `HOME` から session map を決め、Pi CLI process には ACP process の環境を渡す。Builtin で map を worker ごとに分けるには ACP 側の `HOME` を専用 path にする必要があるが、そのままでは Pi の shell command が利用者の `$HOME` / `%USERPROFILE%` にある Git identity、SSH、GitHub CLI 設定を読めない。

また、session map が欠損・破損すると upstream の `session/load` は保存済み ID を復元できない。upstream の `session/list` は `PI_CODING_AGENT_SESSION_DIR` を探索しないため、worker transcript から map を自動再構築できる保証もない。既存実装のように load failure 後に新 session を作ると、旧 context がないまま resume prompt を送ってしまう。

## Decision

- ACP adapter process は worker 専用の `HOME` / `USERPROFILE` を使い、map を分離する。Pi CLI と shell child process は小さな core launcher を通して利用者の `HOME` / `USERPROFILE` に戻す。`acp.env.HOME` / `USERPROFILE` が明示されていれば、その値を Pi CLI 側に使い、Pi 固有の設定・認証 root は `conductor.pi.agentDir` に保つ。
- Builtin Pi の保存 session を `session/load` できない場合は attach を失敗させる。`session/new` に fallback せず、resume prompt も送らない。SessionResumeStore の旧 session ID は保持する。BYO の既存 fallback は変えない。reader は map 欠損時に transcript を推測せず `unavailable` を返す。

## Consequences

- Pi 内の shell command は利用者の Git、SSH、GitHub CLI 等の home-based 設定を利用できる。これらの設定や credential は worker process から読めるため、適用する permission と合わせて管理する。
- Adapter map と Pi transcript は worker ごとに分離され、Pi 固有の settings / auth は `conductor.pi.agentDir` で共有できる。
- Map が失われても resume が新しい会話へ無通知で切り替わることはない。一方、upstream `session/list` に worker session directory の override がないため、map-less な resume や reader の自動復旧は行わない。transcript が残っていても map がない間は reader が履歴を解決できない。
