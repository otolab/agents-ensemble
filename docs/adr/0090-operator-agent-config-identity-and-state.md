# ADR 0090: operator-agent config identity と state / resume の境界

- Status: accepted
- Date: 2026-11-28
- Related: [Issue #914](https://github.com/otolab/agents-ensemble/issues/914), [PR #916](https://github.com/otolab/agents-ensemble/pull/916), [ADR 0046](0046-migrated-session-canonical-slug-mirrors.md), [ADR 0050](0050-operator-agent-conductor-reasoning.md), [ADR 0061](0061-github-slug-session-persistence.md), [ADR 0076](0076-retire-legacy-issue-session-read-fallbacks.md)
- Supersedes in part: [ADR 0061](0061-github-slug-session-persistence.md) の operator-agent config / profile / state / CLI / conversation-resume proposal

## Context

ADR 0061 は operator-agent を単一の `~/.ensemble/operator-agents.config.yaml` に固定し、`--config` を提供しない案を記録している。Issue #914 では、同名 profile を異なる設定から独立して使えるようにしながら、既存の default state と会話の再開方法を保つ必要があった。config file の同一性、profile state の分離、global conversation の明示 resume、Pi resource の共有範囲は互いに異なる境界を持つため、これらを一つの namespace とみなすと既存 state との互換性や競合の説明を誤る。

config 内容の hash を使うと、ファイルを編集しただけで別 namespace になり、同一内容を持つ別ファイルは意図せず同じ state を共有する。file path を識別子にすれば、同一ファイルの別表記・symlink をまとめつつ、別 path の設定を独立させられる。会話 record と Pi transcript は既存どおり `operatorAgentId` で global に保存するため、config scope だけではそれらや Pi の明示共有 root を lock できない。

## Decision

### config identity

- `ensemble operator-agent --config <path>` で config を選ぶ。relative path は起動 cwd 基準、`~` / `~/...` は home 基準で解決し、明示した path が存在しない場合は error にする。config 選択用の環境変数は設けない。
- 選択した file と既定 config の canonical `realpath` が同じなら、config scope を付けず、従来の default namespace を使う。これにより既定 path の明示指定と symlink alias は既存 state を共有する。
- それ以外は canonical config path の UTF-8 表現の SHA-256 を config scope とする。内容が同じでも別 canonical path は別 scope、hard link も別 path として別 scope になる。同じ path の内容を更新しても scope は変わらない。

### state namespace と既定互換

- 既定 config は従来どおり `~/.ensemble/operator-agents/<profile>/` を使う。移行や複製を挟まず、scope のない既存 conversation record も default config のものとして扱う。
- 別 config の profile workspace は `~/.ensemble/operator-agents/.config-scopes/<configScope>/<profile>/` に置く。同じ config identity と profile を使う workspace、watch state、repository-watch state、scheduling events、およびそれらの lock はこの namespace に属する。watch state はさらに canonical GitHub repository slug で分ける。slug を使った保存先・既存 state の割当と migration の規則は ADR 0046 に従い、本 ADR はその profile 配下に config namespace を加える。既定 config の既存 watch state は従来の場所に残り、別 config へ複製しない。
- config を指定する operator-agent 管理コマンドも同じ identity 規則を使い、起動側が選んだ config の namespace を保守・集計する。

### conversation と resume

- conversation record と Pi transcript は引き続き `operatorAgentId` ごとの global path に保存する。config 切替のために既存 record や transcript を複製・移動しない。
- 暗黙の conversation 選択は現在の config scope に一致する record に限る。config scope のない旧 record は default scope に属する。
- `--resume <operatorAgentId>` は scope によらず global record を明示選択できる。再開後の更新はその起動で選択した config scope を record に記録する。これは意図的な cross-config resume の入口であり、会話 ID や provider session を config ごとに複製するものではない。

### Pi roots と lock の範囲

- config は operator-agent の Pi `agentDir` / `projectDir` 解決に使う。既定の project root は config scope と profile workspace に従って分かれる。一方、共通 user `agentDir` は既定値、`PI_CODING_AGENT_DIR`、または利用者が明示した同じ path によって複数 config 間で共有されうる。明示した `projectDir` も同じ path なら共有される。
- config namespace の lock は operator-agent state を保護するが、Pi の共有 root、global conversation record / transcript、provider 側 session を異なる config 間で直列化しない。同じ `operatorAgentId` を別 config から同時に resume しない。共有 root を使う場合は、そこにある Pi settings / auth / resources の更新競合も利用者が管理する。
- この ADR の namespace は Issue session storage や builtin Pi worker の per-Issue storage を変更しない。

## Consequences

- default config と既存 state の保存 path は変わらず、同じ実 file の alias も互換性を保つ。別 file の profile は同名でも workspace と operator state を混ぜない。
- path identity は config の編集による意図しない namespace 分裂を避ける一方、内容が同じ別 file の state は共有しない。hard link の inode 同一性は解決せず、canonical path の違いを境界とする。
- 明示 resume は便利な global 選択を維持するが、選択 config と global provider resource の完全な分離は保証しない。Pi root や会話 ID を明示的に共有したときの競合は config lock の対象外である。
- 環境変数で config file 自体を切り替える経路はない。backend / model / reasoning 等に既存の個別環境変数がある場合も、config identity の選択には使わない。
- ADR 0046 の canonical slug による Issue session / watch state の割当・migration と、ADR 0061 の Issue session canonical slug・resume・copy-only migration の判断はこの ADR の対象外である。config scope は profile state に加わる外側の境界で、これらの slug 規則を置き換えない。ADR 0061 の operator-agent config / profile / state / CLI / conversation-resume proposal は本 ADR に置き換わる。Phase 5 migration gate は引き続き ADR 0076 に従う。
