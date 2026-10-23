# ADR 0043: 明示 user config と project load toggle の併用

- Status: accepted
- Date: 2026-10-23
- Related: [ADR 0020](0020-ensemble-config-setting-resolution.md), [ADR 0042](0042-explicit-config-replaces-user-layer.md), [Issue #558](https://github.com/otolab/agents-ensemble/issues/558)

## Context

ADR 0042 は `--config <path>` を標準 user config の代替として扱い、default → 選択された user config → project config の順で解決すると定めた。その後 #558 で、project config を読むかどうかを user config の `config.loadProjectConfig` で制御できるようになった。

この toggle と `--config` は別の選択である。明示ファイル指定時にも標準 user config の値を混ぜず、同時に選択した user config から project 層の有効・無効を決める必要がある。

また、以前の SessionResumeStore には ACP spawn の env 値を平文保存した形式がある。新形式は env digest のみを保存するが、config digest mismatch で resume を拒否すると通常の resume 書き戻しに到達しないため、旧ファイルの値が残る。

## Decision

- `config.loadProjectConfig` は default と選択された user config（標準 user config または `--config` の明示ファイル）から解決する。既定値は `true`。project config 内の同キーは読み込み判断にも最終設定にも使わない。
- `--config` 指定時は標準 user config を読み込まない。明示ファイルに `config.loadProjectConfig` がなければ default の `true` が適用される。明示ファイルで `false` を指定した場合は project 層を読み込まない。
- toggle が有効な場合は default → 選択された user config → project config の順に deep merge し、同一キーでは後の層を優先する。無効な場合は project 層を省き、default → 選択された user config で解決する。
- resume 用の SessionResumeStore を読み込む際、旧形式の worker ACP env map があれば、値を canonical SHA-256 digest に置き換えてファイルを原子的に書き戻してから resume 整合性を検証する。digest mismatch で resume を拒否する場合も、既存の平文 env 値を残さない。保存済みの session 更新時刻と他の resume state は維持する。

## Consequences

### 良い点

- `--config` による user 設定の差し替えと、project 層の独立した有効・無効を同時に使える。
- 明示 config から標準 user config の toggle が漏れず、解決順が CLI と operator-agent で揃う。
- 旧 resume data の ACP env 値は、resume が拒否されるケースでも digest に移行される。

### トレードオフ

- `--config` に toggle がなく default が `true` の場合、project config は引き続き適用される。同一キーを明示 user config 側で優先したい場合は、そのファイルに `config.loadProjectConfig: false` を指定する。
- 旧 SessionResumeStore の読み込みが必要な場合、env の平文値を除去するためファイルへ原子的な書き戻しが発生する。
