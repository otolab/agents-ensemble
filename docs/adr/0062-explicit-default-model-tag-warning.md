# ADR 0062: 明示された default modelTag の未登録 warning

- Status: accepted
- Date: 2026-11-13
- Related: [ADR 0061](0061-worker-acp-model-tags.md), [Issue #701](https://github.com/otolab/agents-ensemble/issues/701)

## Context

ADR 0061 の初期解釈では、`acp.tags.default` がない場合は warning なしで ACP preset の既定 model に委ねていた。一方、Issue #701 の受け入れ条件は未登録 tag に警告を求めており、profile で `modelTag: default` を明示したケースも対象となる。profile で `modelTag` 自体を省略した場合に内部で選ばれる `default` とは区別が必要。

## Decision

- worker が `modelTag` を明示し、その tag に mapping がなければ harness warning を出す。`modelTag: default` が未登録の場合は warning の後、model を注入せず ACP preset の既定 model を使う。
- worker が `modelTag` を省略した場合は内部で `default` を選ぶが、`acp.tags.default` がなくても warning を出さず ACP preset の既定 model を使う。
- `default` 以外の明示 tag に mapping がない場合は warning を出して `acp.tags.default` を試し、そこにも mapping がなければ model を注入せず ACP preset の既定 model を使う。

## Consequences

- operator は設定に書いた tag の mapping 漏れを warning で把握できる。
- tier の指定を省略する通常経路では、意図した preset default の利用に warning を出さない。
