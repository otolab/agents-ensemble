# ADR 0042: `--config` による user config 層の差し替え

- Status: accepted
- Date: 2026-10-22
- Related: [ADR 0020](0020-ensemble-config-setting-resolution.md), [ADR 0039](0039-session-resume-state-and-operator-projection.md), [ADR 0040](0040-explicit-ensemble-config-file.md), [ADR 0041](0041-ensemble-config-resume-digest.md)

## Context

ADR 0040 は `--config` を user / project config より高い追加 overlay として定めた。しかし config は user と project で別の層であり、起動時の明示ファイルは user config の切り替えとして扱うのが利用者の意図に合う。標準 user config を残して明示ファイルを重ねると、指定ファイルにない値が標準 user config から意図せず引き継がれる。

project config の読み込み可否は `--config` とは独立した制御の対象である。現行の loader は project config があれば常に読み込み、`--config` にその挙動を変更させない。

## Decision

- `ensemble issue` と `ensemble operator-agent` の `--config <path>` は user config のファイル源を置き換える。指定時は `~/.ensemble/config.yaml` を読み込まず、指定ファイルを user 層として扱う。未指定時は標準 user config を使う。
- config はコード内 default → 選択された user config → project config の順で deep merge する。後の層が同じキーを上書きするため、project config は明示 `--config` より高優先となる。
- project config の読み込みは `--config` の有無によらず現行どおり行う。project load toggle の追加・変更はこの ADR と PR の範囲に含めない。
- 各設定項目では、CLI / 環境変数の明示値を config 層より優先する。config 内では project > 選択された user config > コード内 default とする。`conductor.backend` は選択した team profile の値を merged config より優先する。
- 明示パスは current working directory 基準で解決し、`~` と `~/...` を home に展開する。指定ファイルが存在しなければ起動時にエラーとする。`--config` は team profile の `--profile` と独立し、名前付き config profile や環境変数は導入しない。
- 起動時に解決した merged `EnsembleConfig` を canonical JSON 化して SHA-256 digest を sidecar に保存する。object のキー順は正規化し、配列順は維持する。resume 時に現在の実効 config digest と不一致なら conductor resume 前に拒否し、同じ値なら config ファイルの場所が異なっても一致とみなす。
- sidecar には config 値やファイルパスを保存しない。digest のない旧 sidecar は互換性のため resume を許可し、config 一致を検証できない旨を warning で知らせる。既存の MCP digest と ACP spawn 検証も引き続き適用する。
- worker ACP spawn fingerprint の env 比較は canonical env digest のみを保持し、環境変数の値を sidecar に記録しない。

## Consequences

### 良い点

- `--config` で標準 user config の値を引き継がず、user 設定を明示的に切り替えられる。
- project config は別層として保たれ、既存の project 優先順位と共有設定の挙動が変わらない。
- resume の digest はファイル源ではなく、全 config 層を適用した後の実効設定を比較する。

### トレードオフ

- project config と `--config` が同じキーを持つ場合、project 側が優先される。project config より明示ファイルを優先したい場合は、この仕様とは別に project load toggle を設計する必要がある。
- `--config` の切り替えで実効 config digest が変わる場合、既存 session の resume は拒否され、新しい session が必要になる。
