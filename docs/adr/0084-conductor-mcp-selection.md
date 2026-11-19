# ADR 0084: conductor MCP server の明示選択

- Status: accepted
- Date: 2026-11-19
- Related: [Issue #777](https://github.com/otolab/agents-ensemble/issues/777), [ADR 0021](0021-conductor-mcp-config-resolution.md), [ADR 0077](0077-operator-agent-mcp-server-selection.md)

## Context

共有の user MCP 定義は operator-agent だけで利用する場合もある。ADR 0021 の全定義を conductor に渡す方式では、定義を追加するだけで全 repository の conductor にも server が起動する。選択を team profile に置く方法もあるが、環境・repository ごとの接続先の選択は既存の ensemble config の層に置くほうが扱いやすい。

## Decision

- ensemble config の `conductor.mcp.servers` で名前を選ぶ。選択された user config と project config の既存優先順を使い、後者の配列は前者を置き換える。未指定または空配列は選択なしとする。
- 定義は ADR 0021 と同じ user / project の `mcp.json` を名前単位でマージし、選択名だけを Cursor / Pi に渡す。未定義名は両定義ファイルのパスを示して起動を止める。
- 選択後の map の digest を保存する。resume は digest の差で拒否せず現在の選択を使う。ACP worker と operator-agent の選択経路は変更しない。

## Consequences

共有定義が意図せず conductor に渡らなくなる。既存利用者は必要な名前を明示する必要があり、自動移行は行わない。設定の適用範囲は ensemble config に揃い、team profile ごとの選択はできない。
