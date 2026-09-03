# ADR 0021: conductor MCP 設定の 2 層解決と inline 配線

- Status: accepted
- Date: 2026-09-03

## Context

conductor は `@cursor/sdk` の local agent だが、ensemble の正本である MCP 設定を SDK へ渡していなかった。SDK の inline MCP は `Agent.create` / `Agent.resume` の options に渡せる一方、resume 後は再注入が必要であり、ACP worker の設定経路とは分離されている。

必要な要件:

- ユーザ全体の既定とプロジェクト固有の設定を重ねる
- 同名 MCP サーバーはプロジェクト設定で上書きする
- 設定ミスで既存の conductor 起動を壊さない
- `.cursor/mcp.json` への同期や ACP worker への副作用を作らない

## Decision

- `~/.ensemble/mcp.json` を user 層、`<repoRoot>/.agents/mcp.json` を project 層として読む
- `mcpServers` を user → project の順にサーバー名単位で shallow merge する（同名は project が定義全体を置換）
- 解決結果を `Agent.create` / `Agent.resume` のトップレベル `mcpServers` に inline で渡す。`local.settingSources` は変更しない
- JSON、`mcpServers`、またはサーバー定義の形式が不正なファイルは `[mcp]` warning を出してその層だけスキップする。もう一方の層は継続して読み込み、両層が無効なら MCP なしで起動する
- `Agent.resume` および send の in-process reconnect では、セッション開始時に解決した同じ options を再利用する。セッション中の設定変更は hot reload しない
- `${env:...}` / `${workspaceFolder}` 等の値の展開は Cursor SDK に任せる

## Consequences

### 良い点

- user の共通サーバーと project の追加・上書きを、ensemble 固有の正本で一貫して利用できる
- resume 時に非永続な inline MCP が消えることを防げる
- 不正な一層があっても、もう一層と既存の conductor 起動は維持できる
- ACP worker や `.cursor/mcp.json` の管理には影響しない

### トレードオフ

- 不正設定を fail fast せずスキップするため、利用者は `[mcp]` warning を確認する必要がある
- MCP 設定変更は既存 session に反映されず、新しい session の起動が必要
- local SDK が提供する OAuth の対話や MCP プロトコル自体は harness の責務にしない

## 関連

- [#237](https://github.com/otolab/agents-ensemble/issues/237)
- [ADR 0018](0018-team-profile-four-layer-resolution.md) — 多層配置の先例
- [docs/config.md](../config.md) — 利用者向け配置・形式・失敗時の挙動
