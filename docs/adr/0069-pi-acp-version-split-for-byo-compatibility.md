# ADR 0069: BYO / builtin の Pi ACP dependency version を分ける

- Status: accepted
- Date: 2026-11-12
- Supersedes in part: [ADR 0067](0067-pi-acp-upstream-package-wrapper.md)（dependency version assignment only）
- Related: [Issue #670](https://github.com/otolab/agents-ensemble/issues/670)

## Context

ADR 0067 では builtin wrapper と BYO の両方が upstream `pi-acp@0.0.34` を共有する構成だった。しかし `.34` は `session/new` の設定解決時に `get_available_thinking_levels` RPC を呼ぶようになり、既存利用者の Pi CLI `0.80.6` はその command を実装していない。旧 `pi-acp@0.0.33` は同じ呼び出しをせず、これまでの BYO 動作を保てる。

Builtin は core 同梱の Pi CLI と `.34` の新しい RPC に合わせられるが、BYO では利用者が管理する Pi CLI の版を core が決められない。一つの adapter version を両 runtime で使うと、どちらかの互換性を損なう。

## Decision

- core の通常 `pi-acp` dependency は exact `0.0.33` に戻し、BYO の bundled-first 解決と PATH 上の Pi CLI を維持する。
- upstream `pi-acp@0.0.34` は npm alias dependency として別に固定し、builtin wrapper だけが解決・起動する。Builtin は引き続き core 同梱 Pi CLI を使う。
- どちらも upstream npm package をそのまま利用し、adapter source の vendor / fork / 第一方公開 package は作らない。両 runtime の固定版 integration を別々に保つ。
- 将来 adapter version を統一する場合は、BYO が対応対象とする Pi CLI 版で `session/new` / `session/load` を先に実証してから pin を更新する。

## Consequences

- Pi CLI `0.80.6` を使う BYO は既存の `pi-acp@0.0.33` 経路を保ち、builtin は `0.0.34` の新しい設定機能を利用できる。
- core は upstream package を二つの dependency 名で install する。version update の際は BYO / builtin の互換性を別々に確認し、双方の lock entry と integration test を更新する。
- upstream `session/list` の探索制約、worker ごとの map 隔離、builtin の fail-closed resume 方針は [ADR 0067](0067-pi-acp-upstream-package-wrapper.md)、[ADR 0068](0068-builtin-pi-home-and-resume-safety.md)、[ADR 0070](0070-issue-scoped-builtin-pi-storage.md) に従う。
