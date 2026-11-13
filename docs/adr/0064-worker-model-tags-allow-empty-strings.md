# ADR 0064: worker modelTag に空文字・空白のみの tag を許可

- Status: accepted
- Date: 2026-11-13
- Related: [ADR 0062](0062-worker-acp-model-tags.md), [ADR 0063](0063-explicit-default-model-tag-warning.md), [Issue #701](https://github.com/otolab/agents-ensemble/issues/701)

## Context

Issue #701 は profile の `modelTag` と config の `acp.tags` key に任意の文字列を求めている。初回実装は「任意」を非空文字列と解釈し、profile・config parser・resolver・resume store で空文字と空白のみの値を拒否または捨てていた。レビューで受け入れ条件との契約差が指摘された。これらの値は JavaScript の own-property 辞書と JSON sidecar で区別して保持できる。

## Decision

- `modelTag` と `acp.tags` の tag key は文字列をそのまま扱い、空文字と空白のみの文字列も受け付ける。trim、空白判定による拒否、正規化はしない。
- `modelTag` の省略（`undefined`）は従来どおり `default` を選ぶ。明示された `modelTag: ""` は別の tag であり、`acp.tags[""]` があればその mapping を使う。未登録なら warning を出して `default` mapping を試し、そこにも mapping がなければ model を注入せず ACP preset の既定に委ねる。
- config parser と user/project config merge は空文字・空白のみの tag key を own property として保持し、resolver は完全一致で参照する。resume store は値を変更せず保存・読込する。
- YAML で空文字・空白のみの値や key を書く場合は引用符で明示する（例: `modelTag: ""`、`acp.tags` の `"": blank`）。

## Consequences

- Issue の「任意の文字列」という契約と profile/config/resume の実装が一致する。空文字や空白のみも意図して使える。
- 空文字 tag の設定は通常の運用では読みづらいため、team 向け推奨 tier は引き続き `high` / `default` / `low` / `lite` とする。
- 非文字列の `modelTag` は引き続き無効であり、config mapping の値と model catalog の model / reasoning 検証も変わらない。
