# ADR 0045: worker ACP model tag と環境別 model catalog

- Status: accepted
- Date: 2026-10-30
- Related: [ADR 0019](0019-worker-acp-cli-presets.md), [ADR 0020](0020-ensemble-config-setting-resolution.md), [ADR 0042](0042-explicit-config-replaces-user-layer.md)

## Context

worker ごとのモデル tier はチーム構成の一部だが、実際の model ID は provider / gateway / 環境によって異なる。profile に model ID や ACP preset / env を戻すと、同じ team profile を環境間で共有できず、ADR 0020 の「config は環境、profile は構成」という分担も崩れる。

resume では、設定上の tier と起動した model の両方を worker 単位で照合する必要がある。ACP preset ごとに model の受け渡し方法と対応状況も異なる。

## Decision

- profile の worker object は `modelTag`（`high` / `default` / `low` / `fast`）だけを指定する。省略時と kind 文字列 shorthand は `default`。全体 default、preset override、model ID 直書きは設けない。
- ensemble config の `acp.models` は model key → 環境固有 model ID、`acp.tags` は固定 tag → model key の共通 mapping を定義する。両 map は user → project の順に deep merge する。worker 名・kind ごとの model mapping は置かない。
- worker の選択 tag が `acp.tags` にない場合は preset の native default を使う。tag が model key を参照していて、その key が `acp.models` にない場合は worker process を起動する前に失敗する。
- model 注入方式は preset ごとに固定する。

  | preset | 注入方式 |
  |--------|----------|
  | `cursor` | `agent --model <id> acp` |
  | `claude` | `session/new` / `session/load` の Claude settings metadata |
  | `codex` | `CODEX_CONFIG` JSON の `model` |
  | `pi` / `custom` | model mapping がある worker の起動を拒否 |

- SessionResumeStore の worker ACP fingerprint に tag と解決済み model ID を含める。旧 fingerprint で両方が欠けている場合は従来互換として照合を省略する。env 値は保存せず canonical digest のみを保持する。
- profile の旧 `acp` / `workers[].acp` は引き続き拒否する。

## Consequences

### 良い点

- 同じ profile の tier 配分を保ったまま、config の model catalog だけを環境別に差し替えられる。
- worker 名や kind と provider 固有 model ID を結び付けず、profile を環境から独立させられる。
- resume で worker ごとの tier / model 変更を検出できる。

### トレードオフ

- pi と custom ACP command には現在 model を明示的に渡す経路がないため、model mapping を使えない。
- `acp.tags` に tag を用意しない場合、その worker は ACP preset の既定 model を使う。設定漏れと意図的な既定利用を区別するには、運用側で tag を明示する必要がある。
