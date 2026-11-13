# ADR 0062: Pi ACP adapter の内蔵と BYO / builtin runtime

- Status: superseded by [0063](0063-pi-acp-upstream-package-wrapper.md)
- Date: 2026-11-12
- Related: [ADR 0019](0019-worker-acp-cli-presets.md), [ADR 0044](0044-user-scoped-runtime-storage.md), [Issue #670](https://github.com/otolab/agents-ensemble/issues/670)

## Context

Pi worker ACP adapter を third-party optional dependency として解決する方式では、harness と adapter の変更・検証・公開が分かれ、builtin Pi の設定と transcript 保存先も利用者の `~/.pi` に依存する。

## Decision

`svkozak/pi-acp` v0.0.33（commit `1bfcb394088ed879db8fd936b570bb626017f878`）を MIT license と帰属を保持して `packages/builtin-pi-acp` に vendor し、runtime dependency として npm 公開する。BYO Pi を既定のまま保ち、builtin runtime は明示 opt-in として `~/.ensemble/pi/worker/` に Pi 設定・session map・transcript を隔離し、上流更新は package 内の `UPDATING.md` に記録した手順で追従する。

## Consequences

- Adapter と harness の変更・テストを同じ monorepo で行え、通常の install では内部 package の adapter が優先される。
- 公開 package が core の runtime dependency になるため、core と同じ release flow で npm に公開する必要がある。
- Pi CLI 自体は vendor せず、core が既に依存する `@earendil-works/pi-coding-agent` を builtin runtime から明示的に起動する。BYO runtime は従来どおり PATH と Pi の user home を使う。
- builtin runtime は独立した session store を使うため、SessionResumeStore に runtime 種別を残し、reader と resume 検証でも BYO と区別する。
- 上流への変更提案と vendor 差分の維持は引き続き必要であり、自動同期は行わない。
