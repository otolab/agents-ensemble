# ADR 0061: GitHub repo slug をセッション永続化の正本にする

- Status: proposed
- Date: 2026-11-13
- Replaces: [ADR 0046](0046-migrated-session-canonical-slug-mirrors.md)（本 ADR の accepted 後、Status のみ superseded に更新する）
- Related: [Issue #694](https://github.com/otolab/agents-ensemble/issues/694), [Issue #695](https://github.com/otolab/agents-ensemble/issues/695), [Issue #693](https://github.com/otolab/agents-ensemble/issues/693), [Issue #696](https://github.com/otolab/agents-ensemble/issues/696), [Issue #697](https://github.com/otolab/agents-ensemble/issues/697), [Issue #698](https://github.com/otolab/agents-ensemble/issues/698), [Issue #699](https://github.com/otolab/agents-ensemble/issues/699)

## Context

ADR 0044 は正規化した `repoRoot` の SHA-256 を repoKey とし、checkout ごとにユーザー層の保存領域を分けた。ADR 0046 は移行後の重複を避けるため canonical slug mirror を導入したが、新規 session の保存先は path-hash のまま残した。そのため slug が正本になるのは一括移行を通った session に限られ、同じ論理 session の JSON や sidecar が複数箇所に残り得る。

重複があると、古い hash copy が選ばれて最新の `harnessSocketPath` を見失うことがある。Issue #607 では hash 側に socket path がなく、slug 側に稼働中 harness の socket path がある事例が報告された。path-hash のままでは同じ GitHub repository の別 clone も別の一覧になり、Issue #691 の operator-agent が既存 session を横断して把握しづらい問題も残る。

現在の [`resolveEnsemblePaths`](../../packages/core/src/ensemble-paths.ts) は `repoRoot` の hash と Issue URL 由来の slug の両方を返す。新規 `conductor-session` は hash 側を初期保存先にし、[`listSessionResumeStoreLocations`](../../packages/core/src/session/session-resume-store.ts) は slug 配下を走査するときも Store 内 `repoRoot` が現在の checkout と一致することを条件にしている。つまり、保存先の識別と実行時の checkout が一つのキーに結び付いている。

親 Epic #694 はこの結び付きを解き、`repoRoot` を実行コンテキストとして残しながら一覧・索引の分割キーから外す方針を示している。Phase 3 #697 は `ensemble operator-agent --repo-root` を config 読み込み専用と記す。これは conductor を起動する `ensemble issue --repo-root` の用途（worktree・resume 検証）とは別の CLI 契約として両立する。Phase 3 では operator-agent の設定 root が session 索引の絞り込みに再利用されないことを明確にする。

## Decision

### 保存先の識別

- 有効な GitHub Issue URL から `github.com/<owner>/<repo>` を得て、owner と repo を小文字に正規化した canonical slug を repository の保存先とする。
- session 用 user data は `<userEnsembleRoot>/sessions/github.com/<owner>/<repo>/` に保存する。対象は SessionResumeStore、Open Questions / session-state YAML、tool-call history、Pi conductor transcript とする。
- operator-agent の session / watch state / Pi transcript は `<userEnsembleRoot>/operator-agent/github.com/<owner>/<repo>/` に保存する。
- 新規 session の初回保存と以後の flush、resume 後の更新、operator-agent state の更新は canonical slug 配下だけに書く。path-hash への二重書き込みは行わない。有効な GitHub repository を決定できない場合、path-hash を代替の正本として使わず、backend 起動や session state の変更を始める前に、保存先を決定できない理由を示して失敗させる。
- SessionResumeStore と、repoRoot を保持する operator-agent state には正規化済み絶対 `repoRoot` を属性として残す。保存先・一覧・索引の分割キーには使わない。
- これにより ADR 0046 の「新規 session の通常保存先として path-hash を維持する」方針を撤回する。また「移行済み session に限って slug を正本とする」例外も撤回し、全 session で slug を正本とする。

### `repoRoot` は実行コンテキストとして保持する

- SessionResumeStore の `repoRoot`、`conductorCwd`、worker の `acpCwd` は、作成時の実行コンテキストとして引き続き保存する。`repoRoot` は保存先・一覧・索引の分割キーにはしない。
- `repoRoot` は project config と profile の解決、Pi project resources、worktree の特定、および resume の互換性検証に使う。`<repoRoot>/.ensemble/worktrees/issue-N` の worktree 配置も現行どおり維持する。
- slug による一覧・読み取りでは Store の `repoRoot` と現在の `repoRoot` の一致を必須条件にしない。実行を伴う resume では次項の検証を行う。

### 別 clone からの resume

- 同じ `owner/repo` の session は、別 clone からも slug ベースの一覧と読み取りで確認できる。Store に記録された `repoRoot` は一覧から除外する条件ではなく、現在の checkout との互換性を示す属性として表示・診断に使う。
- `--resume` と `--continue` は、保存 Store の正規化済み絶対 `repoRoot` と現在の正規化済み絶対 `repoRoot` が一致するときだけ実行する。一致しない Store は backend の resume や状態更新を始める前に拒否し、保存側と現在側の path を示す。`--continue` では同じ Issue の候補を slug 配下から探したうえで、現在の `repoRoot` と一致する session だけを選ぶ。一致する候補がなく、他 clone の候補だけがある場合は、それを誤って再開せず理由を返す。
- mismatch 時に warning だけで続行したり、現在の clone に worktree を自動再生成したりしない。保存された `conductorCwd` / worker cwd、project config、worktree の状態は clone 間で同じとは限らず、再生成すると既存 provider session を異なる作業環境へ結び付けるおそれがあるためである。記録された clone の場所が変わった場合の明示的な再束縛は、この設計の範囲外とする。

### 索引 API と CLI

- core の discover / list / read API は `githubRepo: "<owner>/<repo>"` を索引範囲とし、必要に応じて `issueUrl` または `conductorAgentId` で絞る。たとえば list API の入力契約は `{ githubRepo, issueUrl?, conductorAgentId? }` とし、resume の入力には同じ slug 範囲に加えて `repoRoot` を渡す。索引 API の repository 選択に `repoRoot` を要求しない。
- CLI の repository 指定は `--github-repo <owner>/<repo>` とする。`ensemble session list --github-repo owner/repo` は同じ slug 配下を clone 横断で列挙し、Issue URL 指定は slug へ解決して絞り込む。`ensemble operator-agent` は `--github-repo owner/repo` を受け取り、省略時は `--repo-root` の `origin` から一意に解決できる場合だけ推定する。推定できなければ slug を明示するよう案内して失敗させる。
- `list_operator_sessions` は任意の `githubRepo: "owner/repo"` で対象を絞る。省略時はその operator-agent が監視・保持している slug を列挙し、`repoRoot` から索引範囲を決めない。
- `ensemble issue <issue-url>` は Issue URL から slug を解決する。`--repo-root` は config、profile、Pi project resources、worktree と resume 互換性のために残し、session 索引の partition には使わない。`ensemble operator-agent --repo-root` は operator-agent の project config / profile 解決に使うが、session discovery、watch state の partition、一覧範囲の決定には使わない。
- operator-agent の repo 単位 state は選択 session の数や slug の一意性にかかわらず slug ごとに分ける。複数 repository を監視する場合も repository ごとに state を分け、path-hash を代替にしない。

### 移行期間と安全性

- Phase 1〜4 では、読み取り時の優先順位を canonical slug → 現在の `repoRoot` から導出できる user path-hash → project-local legacy とする。別 clone の hash は現在の `repoRoot` からは見つけられないため、clone 横断で残存 hash data を拾う責務は Phase 4 の全 hash directory scan に置く。path-hash と project-local legacy は互換読取元に限り、新規作成・通常更新・二重書き込みの宛先にはしない。
- hash-only または project-local legacy の session を resume / 移行するときは、対象ファイルが slug 側にない場合に限って canonical 側へ複製する。slug 側に同じ session のファイルがすでにあれば slug 側を正本として採用し、更新時刻による自動統合や上書きは行わない。`harnessSocketPath` など稼働状態を含む JSON も、この location 優先順位を変えず slug 側を採用する。移行でコピー元は削除・退避しない。Phase 5 で hash 読み取りを終えた後も自動削除しない。移行処理は dry-run で件数と衝突を示し、再実行しても既存 slug data を壊さない。
- SessionResumeStore、Open Questions / session-state YAML、tool-call history、Pi transcript、operator-agent state / watch state は同じ slug-first / no-overwrite 方針に従う。hash から読み込んだ状態を更新する場合、先に不足分だけを slug 側へ promote し、その後の flush は slug 側だけに行う。Pi transcript と operator-agent state も、既存 slug data を上書きせず hash / project legacy source は残す。
- Phase 5 は Phase 4 の移行期間を経たメジャーリリースで user path-hash の read fallback を取り除く。`<userEnsembleRoot>/sessions/<64-hex>/` の探索と path-hash location を削除し、operator-agent の旧 `operator-agent/<repoKey>/` 状態も hash fallback の対象から外す。リリースノートで hash-only data が自動検出されなくなることを案内する。既存 hash directory は自動削除しない。
- project-local legacy (`<repoRoot>/.ensemble/sessions/` 等) は user path-hash とは別の旧保存形式である。Phase 5 でその読み取りも終了するか、期限を設けるかは #699 の実装前に conductor が決める。決定までは既存の最終順位 fallback として読み、書き込み先は slug に移す。worktree path や project config を slug 配下へ移す対象にはしない。
- 旧 `operator-agent/<repoKey>/` の session / watch state は、SessionResumeStore のように slug を含む識別情報を常に持つとは限らない。特に operator session state は `repoRoot` だけでは対象 slug を証明できず、watch state / Pi transcript も複数 slug が混在し得る。slug を一意に結び付けられない状態は自動で任意の repository に割り当てず、Phase 5 前に移行・退避・手動指定のどれで保全するか決める。

### ADR 0046 の扱い

本 ADR が accepted になった時点で、ADR 0046 の Decision のうち「新規 session の通常保存先は path-hash」「移行済み session だけ slug 正本」「全 session が一意の slug に揃うまで operator-agent state は path-hash」という方針を撤回する。path-hash の重複ファイルを自動削除・上書きしない移行上の安全策は、Phase 5 までの互換期間に限って引き継ぐ。

ADR 0046 の本文は履歴として書き換えない。本 ADR の accepted 後に ADR 0046 の Status だけを `superseded by [0061](0061-github-slug-session-persistence.md)` に更新する。

## Documentation impact

次の記述は現行コードを説明しているが、本 ADR の設計とは矛盾するため、各 Phase の実装に合わせて更新する。Phase 0 では未来の仕様を現行説明へ先取りせず、矛盾箇所をここに記録する。

以下の追加行は利用者向け文書の更新担当を示す。operator-agent の state scope、`--repo-root`、`.ensemble/` 固有設定、旧 state の移行・終了条件は operator の判断待ちであり、文書の担当割り当てだけでは仕様を確定しない。

| 文書・箇所 | 現在の記述と矛盾 | 更新する Phase |
|---|---|---|
| [session-logging.md — SessionResumeStore と open question YAML](../session-logging.md#4-sessionresumestore-と-open-question-yaml) の保存先・directory tree、および同節から参照する `repoKey` の説明 | SessionResumeStore、YAML、tool-call history、Pi transcript の保存先を `<repoKey>` としている。全ての新規・更新先を slug に変え、`repoRoot` を保存属性として説明する。 | #693 / #696 |
| [session-logging.md — 同節](../session-logging.md#4-sessionresumestore-と-open-question-yaml) の重複選択・legacy 移行 | 「slug は移行済み session に限る」「新規 session は path-hash」「選択 location に応じて読み取り先を変える」としている。Phase 1〜4 の slug-first fallback と promote、Phase 5 の path-hash 読取終了に合わせる。 | #693 / #696 / #698 / #699 |
| [session-logging.md](../session-logging.md) の冒頭 lifecycle path、operator-agent watch state、Pi transcript、移行・権限の説明 | 図・段落の `sessions/<repoKey>/` と `operator-agent/<repoKey>/` を slug に改め、hash read fallback と project-local legacy の別扱いを記す。 | #693 / #697 / #698 / #699 |
| [live-open-question-control-api.md — Operator-agent watch state](../live-open-question-control-api.md#operator-agent-watch-state-の欠損破損と復旧) と [複数の保存先に同じ SessionResumeStore がある場合](../live-open-question-control-api.md#複数の保存先に同じ-sessionresumestore-がある場合) | watch state と ResumeStore の通常 path を `<repoKey>` とし、slug が移行済み session または一意 slug の場合に限る条件がある。新規 state は常に slug-keyed とし、移行中だけ hash / project legacy を読取 fallback に残す。 | #693 / #696 / #697 / #698 |
| [live-open-question-control-api.md — Endpoint discovery と lifecycle](../live-open-question-control-api.md#endpoint-discovery-と-lifecycle)、[Persistence、acknowledgment、errors](../live-open-question-control-api.md#persistenceacknowledgmenterrors)、[Security と privacy](../live-open-question-control-api.md#security-と-privacy) | `harnessSocketPath` の endpoint index 契約は維持する。JSON / YAML の保存先、slug/hash/legacy の探索順、ファイル権限を slug-first の現行実装に合わせて更新する。 | #693 / #696 / #699 |
| [cli/README.md](../cli/README.md) — `ensemble session` の read commands と `ensemble operator-agent` | Phase 2 で `list` / `show` / `export` / `messages` / `workers messages` / `timeline` の repository 選択を、確定した索引契約に合わせる。Phase 3 で operator-agent の CLI、設定 root、state scope、`--new` の説明を更新する。Phase 5 では path-hash 読取終了を案内する。各 CLI 契約の決定はこの行では行わない。 | #696 / #697 / #699 |
| [architecture.md](../architecture.md) と [operator-input.md](../operator-input.md) — operator-agent の scope、state、watch と復旧 | Phase 3 で別 clone の state の扱い、reset の影響、監視範囲を確定後の設計に合わせる。旧 operator-agent state の移行・fallback 終了を Phase 5 より前にどの Issue が担うかは未割当であり、#698 は現状 `sessions/<repoKey>/` の session data のみを対象とする。 | #697 / Phase 4 の担当は未確定 / #699 |
| [config.md](../config.md) — project `.ensemble/` 設定と Pi resource / transcript path | operator-agent 固有の `.ensemble/` 設定の配置・解決範囲と、Pi の project resources / transcript の扱いを、operator の判断後に記述する。 | #697（仕様決定後） |

### Phase 1〜5 の参照先

| Phase | Issue | この ADR で固定する境界 |
|---|---|---|
| 1 | [#693](https://github.com/otolab/agents-ensemble/issues/693) | 新規 Store、sidecar、tool-call history は slug にのみ書く。hash は互換 read fallback とし、legacy から resume した場合も slug へ promote して hash へ戻さない。 |
| 2 | [#696](https://github.com/otolab/agents-ensemble/issues/696) | slug を主走査にし、clone 横断で list/read を行う。`repoRoot` 一致は索引条件から外し、resume 実行時には一致を検証する。CLI と core API は `githubRepo` / `--github-repo` または Issue URL で索引する。 |
| 3 | [#697](https://github.com/otolab/agents-ensemble/issues/697) | operator-agent の一覧・state・watch を slug 単位にする。`--repo-root` は project config / profile 用に残し、索引に使わない。hash state は移行中の read fallback のみ。 |
| 4 | [#698](https://github.com/otolab/agents-ensemble/issues/698) | hash-only session の全 hash directory を dry-run と衝突報告付きで slug へ非破壊コピーする。既存 slug を上書きせず、hash source は残す。 |
| 5 | [#699](https://github.com/otolab/agents-ensemble/issues/699) | Phase 4 の利用期間を経てメジャーリリースで user path-hash 読取経路を削除する。hash directory の自動削除はしない。project-local legacy の保持期間は別途判断を残す。 |

## Consequences

- 同じ GitHub repository の session を clone path ではなく一つの slug から発見できる。hash と slug の二重書き込み・location ごとの保存先分岐がなくなり、operator が古い copy を正本として扱う危険を減らせる。
- `repoRoot` / `conductorCwd` は session の実行環境として保持される。別 clone から一覧・読み取りはできるが、元の実行環境を誤って再利用しないよう resume は拒否される。
- Phase 1〜4 では旧 path-hash を残したまま読み、slug に無いファイルだけを複製する。既存データを消さず、衝突時には slug を優先するため、移行を再実行しても hash 側の原本と既存 slug 側の状態を自動上書きしない。別 clone にしか残っていない hash-only session は、Phase 4 の scan が済むまで slug 一覧からは見つからない。
- Phase 5 後は移行していない hash-only session が通常の検索では見えなくなる。ユーザー告知と移行可能期間が必要であり、保存ディレクトリ自体の削除は利用者に委ねる。
- clone 間の worktree 再構築・Store の再束縛は自動化しない。これを必要とする場合、branch / commit / config / worker session の整合を定義する別設計が必要になる。

## Open decisions for conductor

- **別 clone からの resume:** `repoRoot` mismatch は拒否し、自動 worktree 再生成をしない提案である。Store に記録された conductor / worker cwd、project config、worktree は clone 固有であり、warning のみで再利用すると別の作業環境に provider session を結び付けるためである。operator の使い勝手に関わる境界なので、本 ADR を accepted にする前に conductor が確認する。
- **`--repo-root` の範囲:** 本 ADR は `ensemble issue` では config / worktree / resume の実行コンテキスト、`ensemble operator-agent` では config / profile の解決先として扱う。#697 の「config 読み込み専用」は後者の範囲に限る前提である。Phase 3 の実装でこの区別が合意と異なる場合は conductor が整理し、子 Issue を更新する。
- **operator-agent の旧 hash state:** #697 は旧 `operator-agent/<repoKey>/` を Phase 5 まで read fallback とするが、#698 の現行スコープは `sessions/<repoKey>/` の session data を対象にし、operator-agent state の移行方法を定めていない。対象 slug を証明できない state を誤った repo に結び付けない保全策を #699 前に決め、必要なら #698 / #699 のスコープを更新する。
- **project-local legacy の読取期限:** `<repoRoot>/.ensemble/sessions/` 等の fallback を Phase 5 で終了するか、期限付きで残すかは #699 の実装前に決める。本 ADR では user path-hash の撤去と同一視せず、両者を別の互換経路として扱う。
