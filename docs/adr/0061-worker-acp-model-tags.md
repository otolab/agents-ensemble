# ADR 0061: worker ACP modelTag の語彙と未登録時の解決

- Status: superseded in part by [0062](0062-explicit-default-model-tag-warning.md)（明示された `default` tag の未登録 warning と、省略時の暗黙 `default` の区別）および [0063](0063-worker-model-tags-allow-empty-strings.md)（空文字・空白のみを含む任意文字列の許可）
- Date: 2026-11-13
- Related: [ADR 0045](0045-worker-acp-model-tags.md), [ADR 0047](0047-worker-acp-model-reasoning.md), [ADR 0048](0048-session-resume-feasibility-config-digest.md), [ADR 0052](0052-acp-model-injection-by-preset.md), [ADR 0054](0054-cursor-acp-runtime-verification.md), [Issue #701](https://github.com/otolab/agents-ensemble/issues/701)

## Context

ADR 0045 は worker の model tag を4語に固定し、その一つを `fast` とした。しかし、Cursor ACP の fast mode を指す `cursorFast` と名前が似ており、model tier と variant option を混同しやすい。また、チームごとに必要な tag を定義できず、登録漏れでも preset の既定 model に静かに戻っていた。

## Decision

- 組み込み team が意味を定める推奨 tier 名を `high` / `default` / `low` / `lite` とする。

  | tag | 組み込み team での意味 |
  |-----|------------------------|
  | `high` | 考える力を優先し、応答が遅くてもよい |
  | `default` | ふつうの基準。middle と呼んでもよい |
  | `low` | 軽くて安価な model を選び、速さを優先 |
  | `lite` | default 相当の model に短めの reasoning を指定するなど、throughput を優先。小さい model 専用ではない |

- `AcpModelTag` は built-in tier 名を含む open string type とする。profile の `workers[].modelTag` と config の `acp.tags` key は任意の非空文字列を受け付ける。model key と tier 名は config 側の `acp.models` / `acp.tags` で対応付ける。
- `default` 以外の選択 tag に mapping がなければ harness warning を出して `acp.tags.default` を試す。そこにも mapping がなければ model を注入せず、ACP preset の既定 model に委ねる。`default` 自体に mapping がなければ warning を出さず preset 既定に委ねる。tag が mapping されているのに参照先 model key がない場合は従来どおり spawn 前に失敗する。
- `fast` は組み込み tier 名ではなく、任意 tag としてだけ扱う。`fast` を `lite` へ自動変換する互換 alias や resume migration は設けない。既存 sidecar の `modelTag` は文字列値をそのまま保持する。
- `cursorFast` は Cursor ACP fast mode を表す別 field のままとし、worker tier `lite` から暗黙に有効化しない。Cursor に対する明示 option の制約は ADR 0054 / 0055 に従う。
- 任意 key を受け付ける `acp.tags` は resume-feasibility digest で map 全体を neutral に分類する。tag mapping の変更は resume feasibility を変えない。

## Consequences

- 組み込み team は4語の共通した意味を説明でき、独自 team は用途に合う tag を追加できる。
- 未登録の non-default tag は warning で気づける。default mapping があればそこを使い、なければ既存の preset default に戻る。default tag 自体の未設定は preset default を意図的に使う経路として扱う。
- `lite` の意味は team の運用慣習であり、harness は model size や reasoning の短さを検証しない。Cursor fast mode の指定とは独立している。
- `fast` を使い続ける既存 profile / config は明示的な custom tag として扱われる場合があるが、built-in の tier 意味を `lite` に読み替える処理は行わない。
