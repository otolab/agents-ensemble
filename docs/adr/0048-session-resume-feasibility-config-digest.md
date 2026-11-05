# ADR 0048: Session resume feasibility と config digest

- Status: accepted
- Date: 2026-11-05
- Related: [ADR 0011](0011-session-sidecar-resume.md), [ADR 0042](0042-explicit-config-replaces-user-layer.md), [ADR 0047](0047-worker-acp-model-reasoning.md), [Issue #616](https://github.com/otolab/agents-ensemble/issues/616)

## Context

ADR 0042 は merge 後の `EnsembleConfig` 全体を sidecar に記録し、どの設定変更でも resume を拒否する。さらに ADR 0047 は worker の `modelTag`・model ID・spawn env digest の差を resume 時に照合する。このため model や model 向け設定を変えただけでも、保存済み session を再接続できない。

resume 可否は「起動時と同じ設定か」ではなく「保存済み session に再接続できるか」で判断する。config 由来で再接続の前提となるのは、Issue worktree の導出方式と worker ACP の実装選択である。session identity、conductor backend、MCP 定義、worker cwd は既存の独立した照合で検証する。

## Decision

### digest scheme

- SessionResumeStore に `ensembleConfigDigestScheme` を追加する。`full` は従来の全体 digest、`resume-feasibility` は本 ADR の v2 digest を表す。
- scheme のない既存 sidecar は `full` として扱う。`full` は merge 後の `EnsembleConfig` 全体を、従来どおり canonical JSON → SHA-256 して比較する。
- 新しい session は `resume-feasibility` を記録し、merge 後の `session.worktree` と `acp.defaultPreset` だけを canonical JSON → SHA-256 して比較する。
- resume は sidecar に保存された scheme を使って現在の config を hash し、digest 不一致なら conductor の resume 前に拒否する。config ファイルの場所ではなく merge 後の値を比較する。
- resume・再保存では既存 sidecar の scheme と digest を引き継ぐ。旧 `full` digest を v2 として解釈し直したり、digest 欠如を新しい digest に置き換えたりしない。
- `resume-feasibility` なのに digest がない sidecar と、未知の scheme は不正な sidecar として拒否する。scheme 省略または `full` で digest がない旧 sidecar は、従来どおり warning を出して config 一致を検証せずに resume し、digest 欠如を保つ。

### config key classification

次の分類を resume digest の正本とする。`acp.env` / `acp.models` は任意のキーを持つ map として、それぞれの map 全体を分類する。

| 分類 | config path | resume 時の扱い |
|------|-------------|----------------|
| critical | `session.worktree` | digest に含め、不一致なら拒否 |
| critical | `acp.defaultPreset` | digest に含め、不一致なら拒否 |
| neutral | `config.loadProjectConfig` | digest から除外 |
| neutral | `profile.default` | digest から除外 |
| neutral | `conductor.model`, `conductor.backend`, `conductor.verbose` | digest から除外 |
| neutral | `conductor.pi.agentDir`, `conductor.pi.projectDir` | digest から除外 |
| neutral | `acp.env`, `acp.models`, `acp.tags.high`, `acp.tags.default`, `acp.tags.low`, `acp.tags.fast` | digest から除外 |
| neutral | `session.lazyWorkers`, `session.maxTurns.tty`, `session.maxTurns.nonTty`, `session.postLoop.wait` | digest から除外 |
| neutral | `github.auth.allowGhAuthTokenFallback` | digest から除外 |
| neutral | `github.monitor.enabled`, `github.monitor.debounceMs`, `github.monitor.pollIntervalMs`, `github.monitor.activePollIntervalMs`, `github.monitor.stopPollWaitMs` | digest から除外 |
| neutral | `tui.layout`, `tui.forceHyperlink` | digest から除外 |

コードの分類表は `EnsembleConfig` の静的な leaf path 全体を `satisfies Record<...>` で満たす。config 型に新しい固定キーを加えたのに分類表を更新しない場合、build / type check が失敗する。動的 map 内の利用者定義キーは親 map の分類を引き継ぐ。

### ACP spawn fingerprint

- preset は常に比較する。preset が `custom` の場合は command と args も比較する。
- `modelTag`、解決済み model ID、env digest は fingerprint に残っていても resume の拒否条件に使わない。built-in preset の args も比較せず、model を表す引数の変更で resume を拒否しない。
- これにより `acp.defaultPreset` の変更は config digest で、CLI / env による preset の変更は spawn fingerprint で検出する。custom command / args の差し替えも引き続き拒否する。

### 既存の独立検証

次の検証・復元は変更しない。

- session identity: `conductorAgentId`、`issueUrl`、`repoRoot`
- conductor backend: sidecar の `conductorBackend`
- MCP 設定: `mcpConfigDigest`
- worker 接続: sidecar `profile` の worker 定義と、保存した `acpCwd` の照合

## Consequences

### 良い点

- v2 sidecar は model、model catalog、reasoning、spawn env、UI、monitor など resume feasibility に無関係な config 変更で拒否されない。
- worktree 方式、ACP preset、custom ACP 実装の差し替え、既存の MCP・identity・backend・cwd の差は引き続き検出できる。
- 旧 sidecar は保存時の digest の意味を保つ。neutral な config 変更だけで旧 `full` digest が一致しなくなった場合は、新しい session を開始して v2 に移行する。
- sidecar に config 値や env 値を保存しない。digest の canonical 化規則も従来どおりである。

### トレードオフ

- v2 では model や env の変更を harness が拒否しない。ACP の `session/load` 可否は既存の ACP 接続経路に委ねる。
- `EnsembleConfig` の新しい固定キーには分類判断が必要になる。型チェックで分類漏れを検出し、意図した分類を ADR とテストに反映する。
