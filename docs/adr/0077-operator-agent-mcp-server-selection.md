# ADR 0077: operator-agent MCP server 選択と設定 source

- Status: accepted
- Date: 2026-11-16
- Related: [ADR 0021](0021-conductor-mcp-config-resolution.md), [Issue #731](https://github.com/otolab/agents-ensemble/issues/731)

## Context

Issue conductor と operator-agent は `ConductorAgent` と backend を共有するが、MCP 設定の解決単位は異なる。Issue conductor は repository と user の MCP 設定を既存方針に従って解決する。一方、operator-agent では profile ごとに必要な server だけを選べること、起動 repository や cwd によって選択結果が変わらないことが必要である。

ADR 0031 と ADR 0050 は、operator-agent 専用の設定と MCP 選択方針が定まる前の設計上の前提を記録した歴史文書である。本 ADR は operator-agent の MCP 選択だけを決めるもので、MCP 全体の再定義や Issue conductor の既存方針の変更を意図しない。既存 ADR の本文・Status は変更しない。

## Decision

- この方針は operator-agent のみに適用する。Issue conductor の user / project MCP 解決は [ADR 0021](0021-conductor-mcp-config-resolution.md) に従い、変更しない。
- `~/.ensemble/operator-agents.config.yaml` で選択した profile の `profiles.<name>.mcp.servers` が指定されていれば、その配列を使い `common.mcp.servers` を置き換える。profile 側が省略された場合に限り `common.mcp.servers` を継承する。profile 側が `[]` なら common の選択も含め MCP server を無効にする。
- 解決した server 名に対応する定義だけを user の `~/.ensemble/mcp.json` から読み込む。ファイル内に定義があるだけでは server を起動しない。
- 選択結果が空なら `~/.ensemble/mcp.json` を読み込まず、MCP server を起動しない。
- operator-agent は project の `<repoRoot>/.agents/mcp.json` を読み込まず、repository cwd / launch cwd に依存して MCP server の選択や定義の解決先を変えない。
- この決定は transport、backend SDK の対応範囲、MCP server の権限モデルを変更しない。

## Consequences

- operator-agent は common の既定 server を profile ごとに明示的に置き換えたり、空配列で無効にしたりできる。server 定義を共通ファイルに置いただけで起動することはない。
- 同じ operator profile は起動した repository にかかわらず同じ MCP server 選択を使う。Issue conductor の repository 固有 MCP 設定と既存動作は保たれる。
- operator-agent の選択規則は現行設定の説明として扱う。ADR 0031 / 0050 は過去の設計前提の記録として残し、本 ADR はそれらの Status に影響しない。
