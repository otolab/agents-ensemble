# ADR 0076: Issue session の legacy read fallback 廃止と migration 手順

- Status: accepted
- Date: 2026-11-15
- Related: [ADR 0025](0025-conductor-agent-backend-sdk-and-pi.md), [Issue #698](https://github.com/otolab/agents-ensemble/issues/698), [Issue #699](https://github.com/otolab/agents-ensemble/issues/699), [Issue #720](https://github.com/otolab/agents-ensemble/issues/720), [Issue #723](https://github.com/otolab/agents-ensemble/issues/723), [PR #722](https://github.com/otolab/agents-ensemble/pull/722), [PR #724](https://github.com/otolab/agents-ensemble/pull/724)
- Supersedes in part: [ADR 0025](0025-conductor-agent-backend-sdk-and-pi.md) の Pi conductor transcript の project-local runtime path、および [ADR 0061](0061-github-slug-session-persistence.md) の Phase 5 real-data gate と project-local fallback の扱い

## Context

ADR 0061 は Phase 5 で legacy read fallback を外す前提として、実データの全件 inventory、checksum / disposition の照合、watch state の復元または archive acceptance、さらに全 checkout root の確認を求めていた。#699 の当初 handoff にもこの gate が引き継がれていた。

operator は 2026-11-14 の判断でこの pre-release 実データ gate を置き換えた。必要なのは、既存 migration tool の使い方を利用者へ案内すること、移行後の read path と fallback retirement を fixture で確認すること、collision / corruption / ambiguous assignment を上書き・推測で解決しない契約を維持することである。この環境や全利用者の実データを release 前に移行・検証する必要はない。また `inq-4` への回答 `remove-project-legacy` により、user path-hash と独立して扱っていた project-local fallback も今回の release で廃止する。

旧データを自動で削除せず、起動時・継続実行の migration を加えない方針は維持する。旧データは disk 上に残る一方、通常の list / read / resume では見えなくなるため、その挙動と任意 migration の手順を文書化する必要がある。watch migration tool の外部 symlink escape は [#723](https://github.com/otolab/agents-ensemble/issues/723) / [PR #724](https://github.com/otolab/agents-ensemble/pull/724) で修正され、独立 review の後に merge された。migration 手順では root 境界の安全性と manifest の確認を引き続き示す。

## Decision

- Issue session の SessionResumeStore、Open Questions / session-state YAML、tool-call snapshot、Pi conductor transcript の runtime read / write は user root の canonical GitHub slug 配下だけで行う。
- `~/.ensemble/sessions/<repoKey>/` と `<repoRoot>/.ensemble/sessions/` の Issue session data、および `<repoRoot>/.ensemble/pi/sessions/` の legacy conductor transcript は runtime read fallback として残さない。旧 user hash / slug-keyed watch state と project-local watch state も operator-agent runtime から読まない。worker 用 Pi storage など別の保存契約は本 ADR の対象外とする。
- 旧 path-hash / project-local data が必要な利用者は、migration tool を明示実行する。手順は checkout root の選択、dry-run、manifest の root completeness / checksum / disposition / collision / unresolved の確認、必要なら profile と checkout を指定した `--apply`、apply 後の manifest 確認と recovery を含める。
- migration は copy-only とし、source の削除・rename、異なる destination の上書き、corrupt / ambiguous data の推測割当をしない。collision、corruption、曖昧な Issue / profile / transcript は未解決として保全する。watch state の cursor・listener・pending report は一つの bundle として扱う。
- fallback retirement 後、未移行 data は通常の list / read / resume / watch に表示されないが、data 自体は自動削除しない。利用者は必要に応じて migration procedure を実施する。runtime startup migration、continuous migration check、`ensemble doctor` の migration detection は追加しない。
- fallback removal と new-store read behavior は test fixture で確認する。利用者の実データ移行や全 checkout inventory の完了は release gate にしない。変更の release level は minor とする。
- ADR 0061 の本文は変更しない。旧 ADR の Phase 5 実データ gate と project-local fallback に関する判断は、本 ADR と current-state documentation が supersede する。

## Consequences

- migration を行わない場合、旧 data は disk に残るが runtime session discovery / history / watch に現れない。通常の利用導線へ戻すには tool による明示的な copy が必要になる。
- dry-run は manifest を作り、既定では source / destination data を変更しない。apply は再 scan して新しい manifest を作成し、同 checksum destination は no-op、異なる内容は collision として保持する。
- complete real-world migration evidence は release 前に集めないため、利用者自身が source inventory と manifest を確認する手順を正本の user documentation に保つ。
- `#699` の実装は #723 の symlink boundary correction を含めない。#723 は独立した PR で merge・review 済みであることを前提とし、#699 自身の review / verification も別途必要とする。
