# ADR 0041: resolved ensemble config の resume 整合性

- Status: superseded by [0042](0042-explicit-config-replaces-user-layer.md)
- Date: 2026-10-22
- Related: [ADR 0011](0011-session-sidecar-resume.md), [ADR 0040](0040-explicit-ensemble-config-file.md)

## Context

ADR 0040 の実装では、起動時に使った config を sidecar に記録せず、`conductor.model` など既存の整合性検査対象外の変更を resume 時に検出できなかった。Issue #547 は MCP digest と同様、起動時の設定を sidecar に記録して不一致を検出するよう求めている。

config には `acp.env` など秘密値を含みうるため、解決済み config の内容やファイルパスは sidecar に保存しない。

## Decision

- `ensemble issue` と `ensemble operator-agent` は共通の config loader を使い、`--config <path>` を受け付ける。config 層は default → user → project → 明示指定ファイルの順に deep merge し、項目値の優先順は CLI → env → 明示指定 → project → user → default とする。`conductor.backend` は選択した team profile の値を merged config より優先する。
- 明示パスは current working directory 基準で解決し、`~` と `~/...` を home に展開する。team profile の `--profile` から config path は推測せず、config 用の環境変数や名前付き profile は導入しない。
- 起動時に解決した `EnsembleConfig` 全体を canonical JSON 化し、SHA-256 digest を sidecar に保存する。オブジェクトのキー順は正規化し、配列順は維持する。
- resume 時は現在の解決済み config の digest と比較し、不一致なら agent の resume 前に拒否する。ファイルパスではなく実効設定を比較するため、異なるパスでも merge 後の値が同じなら一致とみなす。
- digest のない旧 sidecar は互換性のため resume を許可し、config 整合性を検証できない旨を warning で伝える。
- 既存の MCP digest と ACP spawn 検証は引き続き適用する。

## Consequences

### 良い点

- `conductor.model` や `acp.env` を含む実効 config の変更を resume 前に検出できる。
- sidecar に平文の config 値や config ファイルのパスを複製しない。
- 旧 sidecar を直ちに使えなくせず、新しい起動から digest 検証へ移行できる。

### トレードオフ

- config のどの項目が変わっても resume を拒否する。変更後の設定を適用するには新しい session を開始する。
- digest のない旧 sidecar は比較できないため、警告後に従来どおり resume する。
