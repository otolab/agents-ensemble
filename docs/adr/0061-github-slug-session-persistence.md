# ADR 0061: GitHub repo slug をセッション永続化の正本にする

- Status: proposed
- Date: 2026-11-13
- Replaces: [ADR 0046](0046-migrated-session-canonical-slug-mirrors.md)（本 ADR の accepted 後、Status のみ superseded に更新する）
- Related: [Issue #694](https://github.com/otolab/agents-ensemble/issues/694), [Issue #695](https://github.com/otolab/agents-ensemble/issues/695), [Issue #693](https://github.com/otolab/agents-ensemble/issues/693), [Issue #696](https://github.com/otolab/agents-ensemble/issues/696), [Issue #697](https://github.com/otolab/agents-ensemble/issues/697), [Issue #698](https://github.com/otolab/agents-ensemble/issues/698), [Issue #699](https://github.com/otolab/agents-ensemble/issues/699)

## Context

ADR 0044 は正規化した `repoRoot` の SHA-256 を repoKey とし、checkout ごとにユーザー層の保存領域を分けた。ADR 0046 は移行後の重複を避けるため canonical slug mirror を導入したが、新規 session の保存先は path-hash のまま残した。そのため slug が正本になるのは一括移行を通った session に限られ、同じ論理 session の JSON や sidecar が複数箇所に残り得る。

重複があると、古い hash copy が選ばれて最新の `harnessSocketPath` を見失うことがある。Issue #607 では hash 側に socket path がなく、slug 側に稼働中 harness の socket path がある事例が報告された。path-hash のままでは同じ GitHub repository の別 clone も別の一覧になり、Issue #691 の operator-agent が既存 session を横断して把握しづらい問題も残る。

現在の [`resolveEnsemblePaths`](../../packages/core/src/ensemble-paths.ts) は `repoRoot` の hash と Issue URL 由来の slug の両方を返す。新規 `conductor-session` は hash 側を初期保存先にし、[`listSessionResumeStoreLocations`](../../packages/core/src/session/session-resume-store.ts) は slug 配下を走査するときも Store 内 `repoRoot` が現在の checkout と一致することを条件にしている。つまり、保存先の識別と実行時の checkout が一つのキーに結び付いている。

親 Epic #694 は `repoRoot` を実行コンテキストとして残しながら、一覧・索引の分割キーから外す方針を示している。operator はさらに、`ensemble operator-agent` から `--repo-root` と `repoRoot` 基準のグループ分けをなくし、slug ごとの repository 群をまとめて扱う user 層の agent にする方針を確定した。対象を絞らない起動ではローカルに保存された全 slug を扱い、必要なら `otolab/*` のような範囲を指定する。operator-agent 固有設定は `~/.ensemble/` に置く。これは `ensemble issue --repo-root` の worktree・config・resume 用途には及ばない。

移行対象には Issue session だけでなく operator-agent の会話・watch state・Pi transcript もある。旧 operator-agent state は `repoKey` 配下に置かれ、会話は slug を持たず、watch state には複数 repository の cursor や未 dispatch report が混在し得る。内容から根拠なく slug を決めると、会話の誤分割や watch 通知の取りこぼしにつながるため、移行時に対象を証明できないデータは別領域に保全しなければならない。

## Decision

### 保存先の識別

- 有効な GitHub Issue URL から `github.com/<owner>/<repo>` を得て、owner と repo を小文字に正規化した canonical slug を repository の保存先とする。
- session 用 user data は `<userEnsembleRoot>/sessions/github.com/<owner>/<repo>/` に保存する。対象は SessionResumeStore、Open Questions / session-state YAML、tool-call history、Pi conductor transcript とする。
- operator-agent の会話と Pi transcript は `<userEnsembleRoot>/operator-agent/` の user-level conversation records に保存し、watch state は `<userEnsembleRoot>/operator-agent/github.com/<owner>/<repo>/` に slug ごとに保存する。
- Issue session の初回保存と以後の flush、resume 後の更新は canonical slug 配下だけに書く。path-hash への二重書き込みは行わない。有効な GitHub repository を決定できない場合、path-hash を代替の正本として使わず、Issue session の backend 起動や state 変更を始める前に理由を示して失敗させる。operator-agent の global conversation は repository slug がなくても開始できる。
- SessionResumeStore には正規化済み絶対 `repoRoot` を実行環境の属性として残す。operator-agent 自身の新規 state に `repoRoot` を保存先・設定・一覧・索引の分割キーとして持たせない。
- これにより ADR 0046 の「新規 session の通常保存先として path-hash を維持する」方針を撤回する。また「移行済み session に限って slug を正本とする」例外も撤回し、全 session で slug を正本とする。

### `repoRoot` は実行コンテキストとして保持する

- SessionResumeStore の `repoRoot`、`conductorCwd`、worker の `acpCwd` は、作成時の実行コンテキストとして引き続き保存する。`repoRoot` は保存先・一覧・索引の分割キーにはしない。
- `repoRoot` は project config と profile の解決、Pi project resources、現在の worktree の特定に使う。保存値は前回の実行コンテキストを示す情報であり、現在の clone との一致を resume の必須条件にはしない。`<repoRoot>/.ensemble/worktrees/issue-N` の配置規則は維持する。
- slug による一覧・読み取り・resume 候補の探索では Store の `repoRoot` を除外条件にしない。resume は現在の `repoRoot` を実行先として使い、保存値との違いは復旧判断・診断の材料にする。

### 別 clone / `repoRoot` が変わった状態からの Issue session resume

- 同じ `owner/repo` の session は、別 clone からも slug ベースの一覧と読み取りで確認できる。Store に記録された `repoRoot` は一覧から除外する条件ではなく、現在の checkout との互換性を示す属性として表示・診断に使う。
- `--resume` と `--continue` は Issue URL / canonical slug と `conductorAgentId` で session を選ぶ。保存 Store の `repoRoot` と現在の `repoRoot` が違うことだけを理由に拒否しない。現在の clone の project config、profile、Pi resources、worktree を実行コンテキストとして使い、古い path は conductor へ伝える復旧情報に含める。
- この方針は `repoRoot` mismatch だけを resume の拒否理由から外す。Issue / conductor ID、backend、MCP / config digest、worker ACP 設定など別の互換性検証を一律に無効化しない。別の検証に失敗した場合は対象と理由を明示する。
- 現在の clone に対象 Issue の worktree があり、同じ repository / Issue のものと確認できる場合はそれを再利用する。必要な worktree が見つからなければ警告したうえで、Issue 用 branch が利用できる場合はそれを使い、なければ通常の新規 worktree と同じ base 解決規則で再生成する。既存 worktree の強制削除、reset、別 worktree からの branch の強制奪取はしない。予定 path が別 directory や別 worktree に使われている、または branch を安全に使えない場合は、それを上書きしない。識別可能な別 recovery path を使えなければ明示的に失敗させる。
- worktree の再生成は削除済み worktree 内の未コミット変更や、現在の clone に存在しない未 push commit を復元しない。harness は保存 root と現在 root、worktree の再利用 / 再生成 / 解決失敗を conductor に通知し、conductor が branch・status・利用可能な変更を確認して作業再開の手順を決める。
- worker の保存 `acpCwd` が旧 clone の path を指していても、その path の不一致だけでは resume を拒否しない。現在解決した worktree を実行先として復元を試みる。harness が worker の ACP session 復元失敗を検出した場合は、どの worker が復元できず fresh session に切り替わったか、または再開不能かを conductor に知らせる。旧 prompt や tool を自動再送せず、conductor が作業状態を確認して必要な指示を出す。ACP 設定など別の互換性検証に失敗した場合は、その理由を明示して止める。
- conductor 自身の backend session を復元できない場合、または worktree を安全に解決できない場合は、resume 成功と報告しない。復元済み・復旧を伴う継続・復元失敗を区別し、失敗時は既存 Store や他の worktree を成功した新状態で置き換えない。root mismatch に応じた Store 更新は、復旧が成立した後の通常 flush に限る。

### 索引 API と session CLI

- core の discover / list / read API は `githubRepo: "<owner>/<repo>"` を索引範囲とし、必要に応じて `issueUrl` または `conductorAgentId` で絞る。list API の入力契約は `{ githubRepo, issueUrl?, conductorAgentId? }` とし、resume の入力には同じ slug 範囲に加えて `repoRoot` を渡す。索引 API の repository 選択に `repoRoot` を要求しない。
- `ensemble session list` は省略時に全 slug を列挙し、`--github-repo <owner>/<repo>` または `--issue-url <url>` で絞り込める。`show` / `export` / `messages` / `workers messages` / `timeline` のように session ID を読む command は `--github-repo` または `--issue-url` で範囲を指定する。両方が渡された場合、Issue URL の slug が指定 repository と一致しなければ fail fast する。session ID だけで repository をまたいで候補を推測しない。
- `ensemble issue <issue-url>` は Issue URL から slug を解決する。`ensemble issue --repo-root` は config、profile、Pi project resources、worktree、resume 互換性のために残すが、session 索引の partition には使わない。

### operator-agent の範囲・設定・状態

- operator-agent は user 層の一つの agent として複数 repository を扱う。既定の scope は user 層に保存された全 canonical slug group であり、GitHub API から repository 一覧を新たに取得する意味ではない。保存・watch state は slug ごとに分け、`list_operator_sessions` は対象 group の session を一つの一覧に統合する。
- operator-agent の CLI 案は `ensemble operator-agent [--repo-filter <owner/repo|owner/*>]... [--resume <operatorAgentId>|--new] [--config <path>]` とする。`--repo-filter` は複数指定でき、1 件以上あれば指定 pattern のいずれかに一致する slug だけを対象にする。省略時は operator-agent config の scope を使い、その設定もなければ全 slug group を対象にする。clone path や `origin` から scope を推定しない。`--repo-root` は受け付けない。
- operator-agent 固有設定の既定ファイルは `~/.ensemble/operator-agent/config.yaml` とする。scope 設定は次の形を提案し、`repositories.include` が省略された場合は全 slug group を対象にする。

  ```yaml
  repositories:
    include:
      - "otolab/*"
  ```

- 共通の backend / model / auth 設定は既存の user 層 `~/.ensemble/config.yaml`（または明示 `--config`）から解決する。operator-agent は起動元 repository の `.ensemble/config.yaml`、project profile、project Pi resources を読まない。user 層の profile / Pi resources は `~/.ensemble/` 配下から解決する。移行 script は session data を移し、project config は自動移行しない。
- operator conversation と Pi transcript は `~/.ensemble/operator-agent/conversations/<operatorAgentId>/` の user-level records とし、repository slug に分割したり、複数 conversation を本文から統合したりしない。watch state は `~/.ensemble/operator-agent/github.com/<owner>/<repo>/watch-state.json` に slug ごとに保存する。`list_operator_sessions` は任意の exact `githubRepo` で絞り、session 一覧の各項目に canonical slug を含める。
- operator-agent の launch `repoRoot` は backend session の実行コンテキスト属性としてだけ保持し、保存先・設定・scope・一覧・索引のキーにはしない。別 `repoRoot` から既存 operator conversation を resume する場合は、backend 起動・state 更新前に mismatch を拒否する案とする。自動再束縛はしない。`--new` は新しい `operatorAgentId` の conversation を始め、旧 conversation record / Pi transcript、watch state、Issue session data を削除しない。`--resume` と `--new` は同時指定できず、複数の既存 conversation から暗黙に一つを選ばない。これは安全側の Phase 3 提案であり、resume 時の launch cwd 条件は operator 確認事項として残す。

### 移行期間と安全性

- Phase 1〜4 では、読み取り時の優先順位を canonical slug → 現在の `repoRoot` から導出できる user path-hash → project-local legacy とする。別 clone の hash は現在の `repoRoot` からは見つけられないため、clone 横断で残存 hash data を拾う責務は Phase 4 の全 hash directory scan に置く。path-hash と project-local legacy は互換読取元に限り、新規作成・通常更新・二重書き込みの宛先にはしない。
- hash-only または project-local legacy の session を resume / 移行するときは、対象ファイルが slug 側にない場合に限って canonical 側へ複製する。slug 側に同じ session のファイルがすでにあれば slug 側を正本として採用し、更新時刻による自動統合や上書きは行わない。`harnessSocketPath` など稼働状態を含む JSON も、この location 優先順位を変えず slug 側を採用する。移行でコピー元は削除・退避しない。Phase 5 で hash 読み取りを終えた後も自動削除しない。移行処理は dry-run で件数と衝突を示し、再実行しても既存 slug data を壊さない。
- Issue session の SessionResumeStore、Open Questions / session-state YAML、tool-call history、Pi conductor transcript は slug-first / no-overwrite 方針に従う。旧 session を読み込んだ場合は不足分だけを slug 側へ promote し、その後は slug 側だけを更新する。既存 hash / project legacy source は残す。
- Phase 4 #698 の移行 script は user path-hash の Issue data、旧 `operator-agent/<repoKey>` state、operator が列挙した checkout の project-local `.ensemble/sessions/` / `.ensemble/operator-agent/` / `.ensemble/pi/sessions/` を棚卸しし、file ごとの source path・種別・判定・target・SHA-256 を機械可読 inventory に残す。Issue data は `issueUrl` で slug を証明できる場合に限り対応 group へコピーする。operator conversation は repository に割り当てず、legacy `agentId` ごとの user-level conversation としてコピーし、同一 agent ID の異なる内容は collision とする。
- watch state は `conductorAgentId` ごとの一まとまりで扱う。対応する SessionResumeStore の `issueUrl` が一意の canonical slug を示し、同じ ID の pending report があれば全 report の `issueUrl` も一致するときだけ、その slug の watch state へ移す。`watches` / cursors / question snapshots / message listeners / message cursors / pending reports の一部だけを切り離して混ぜない。Store がない、slug が複数候補、URL が不一致、state が壊れている場合は、該当 bundle または分割不能な source 全体を `~/.ensemble/operator-agent/legacy/` に checksum 付きでコピーし、manifest に理由と recovery 元を記録する。`repoRoot` や会話本文から slug を推測しない。
- operator Pi transcript は transcript ID が operator conversation の `agentId` と一意に一致する場合だけその conversation にコピーする。対応する conversation を特定できない、同じ ID の source が衝突する、または内容が壊れている場合は raw source を legacy archive に保全する。移行先の会話や watch state が既にある場合は上書き・自動統合しない。
- migration は copy-only とし、source path-hash / project-local files を削除・rename しない。同一 checksum の既存 destination は no-op、異なる内容の destination は collision として source を archive に保全する。現行 `migrate-project-ensemble-runtime-to-user.mjs` は project-local files に `rename` を使うため、#698 で copy・checksum 検証方式へ改める。project-local source を全 checkout から収集できない場合、Phase 5 でもその fallback は外さない。
- #697 の新しい operator-agent path への切替は、#698 の移行 script が利用でき、旧 state のコピーと棚卸しを実行できる状態になるまで利用者へ出さない。順序を入れ替えられない場合は、新 CLI と migration tool を同じ release に含め、upgrade 前の移行を案内する。
- Phase 5 #699 は Phase 4 の inventory を検証して user path-hash read fallback と旧 `operator-agent/<repoKey>` の自動読取を削除する。通過条件は、各 source item が (a) 対象と SHA-256 を照合した slug/global conversation copy、(b) 同一内容と確認済みの既存 destination、または (c) checksum と recovery 手順を持つ legacy archive のいずれかに計上され、未計上 source・未検証 copy・未記録 collision がゼロであること。legacy operator conversation は新 path からの resume を検証するか、resume できない記録を archive-only として operator が受け入れた記録を gate に含める。watch data が archive のみに残る場合も、再登録後の初回 snapshot が既存 open question を再通知しない制約を示したうえで、operator の archive-only acceptance を要する。未達なら fallback を削除しない。hash directory 自体は自動削除しない。
- project-local legacy read fallback は user path-hash と別の gate で扱う。#698 は operator が完全性を確認した checkout-root inventory の各 root を走査し、copy/archive の検証結果を manifest に記録する。#699 の担当者は manifest と operator の inventory 完了確認を照合し、全 root の走査、全 source item の copy/archive checksum、collision の処置、watch archive-only の operator acceptance がそろった場合に限って project-local session fallback の削除を許可する。root inventory がない・不完全・検証不能なら #699 では fallback を残す。worktree path や project config 自体は slug 配下へ移さない。

### ADR 0046 の扱い

本 ADR が accepted になった時点で、ADR 0046 の Decision のうち「新規 session の通常保存先は path-hash」「移行済み session だけ slug 正本」「全 session が一意の slug に揃うまで operator-agent state は path-hash」という方針を撤回する。path-hash の重複ファイルを自動削除・上書きしない移行上の安全策は、Phase 5 までの互換期間に限って引き継ぐ。

ADR 0046 の本文は履歴として書き換えない。本 ADR の accepted 後に ADR 0046 の Status だけを `superseded by [0061](0061-github-slug-session-persistence.md)` に更新する。

## Documentation impact

次の記述は現行コードを説明しているが、本 ADR の設計とは矛盾するため、各 Phase の実装に合わせて更新する。Phase 0 では未来の仕様を現行説明へ先取りせず、矛盾箇所と更新担当を記録する。

| 文書・箇所 | 現在の記述と矛盾 | 更新する Phase |
|---|---|---|
| [session-logging.md — SessionResumeStore と open question YAML](../session-logging.md#4-sessionresumestore-と-open-question-yaml) の保存先・directory tree、および同節から参照する `repoKey` の説明 | SessionResumeStore、YAML、tool-call history、Pi transcript の保存先を `<repoKey>` としている。全ての新規・更新先を slug に変え、`repoRoot` を保存属性として説明する。 | #693 / #696 |
| [session-logging.md — 同節](../session-logging.md#4-sessionresumestore-と-open-question-yaml) の重複選択・legacy 移行 | 「slug は移行済み session に限る」「新規 session は path-hash」「選択 location に応じて読み取り先を変える」としている。Phase 1〜4 の slug-first fallback と promote、Phase 5 の path-hash 読取終了に合わせる。 | #693 / #696 / #698 / #699 |
| [session-logging.md](../session-logging.md) の冒頭 lifecycle path、operator-agent watch state、Pi transcript、移行・権限の説明 | `sessions/<repoKey>/` は session の新規保存先ではなく fallback として説明し、Issue Store の `repoRoot` 属性と slug path を分ける。operator conversation の user-level path、per-slug watch path、copy-only migration と archive gate を追記する。 | #693 / #696 / #697 / #698 / #699 |
| [live-open-question-control-api.md — Operator-agent watch state](../live-open-question-control-api.md#operator-agent-watch-state-の欠損破損と復旧) と [複数の保存先に同じ SessionResumeStore がある場合](../live-open-question-control-api.md#複数の保存先に同じ-sessionresumestore-がある場合) | watch state と ResumeStore の通常 path を `<repoKey>` とし、slug への昇格条件が session location に依存している。watch は slug group ごとに保存し、migration は SessionResumeStore の一意な Issue URL で確認できる record だけ分割する。 | #693 / #696 / #697 / #698 |
| [live-open-question-control-api.md — Endpoint discovery と lifecycle](../live-open-question-control-api.md#endpoint-discovery-と-lifecycle)、[Persistence、acknowledgment、errors](../live-open-question-control-api.md#persistenceacknowledgmenterrors)、[Security と privacy](../live-open-question-control-api.md#security-と-privacy) | `harnessSocketPath` の endpoint index 契約は維持する。JSON / YAML の保存先と slug/hash/project legacy の探索・移行順、owner-only 権限を新しい path に合わせる。 | #693 / #696 / #698 / #699 |
| [cli/README.md](../cli/README.md) — `ensemble session` の read commands と `ensemble operator-agent` | Phase 2 で session read の repository 選択と issue URL 不一致時の fail-fast を記す。Phase 3 で `operator-agent --repo-root` を削除し、全 slug が既定、`--repo-filter`、user-level config と会話選択を説明する。Phase 5 で path-hash fallback の終了と archive recovery を案内する。 | #696 / #697 / #699 |
| [architecture.md](../architecture.md) と [operator-input.md](../operator-input.md) — operator-agent の scope、state、watch と復旧 | 全 slug group を既定でまとめる scope、slug ごとの watch state、global conversation、operator-agent の `--new` 非破壊動作、旧状態の copy/archive と Phase 5 の継続性 gate を記す。Issue session については、root mismatch 単独で拒否しないこと、worktree / worker の復旧報告と失敗の扱いを記す。 | #696 / #697 / #698 / #699 |
| [config.md](../config.md) と [settings.md](../settings.md) — project `.ensemble/` 設定と Pi resource / transcript path | operator-agent 固有設定を `~/.ensemble/operator-agent/config.yaml` に置き、project config/profile/Pi resources を読まない契約と共通 user config の扱いを記す。session migration は config files を対象にしない。 | #697 |

### Phase 1〜5 の参照先

| Phase | Issue | この ADR で固定する境界 |
|---|---|---|
| 1 | [#693](https://github.com/otolab/agents-ensemble/issues/693) | 新規 Store、sidecar、tool-call history は slug にのみ書く。hash は互換 read fallback とし、legacy から resume した場合も slug へ promote して hash へ戻さない。`repoRoot` は実行 context として保持するが、slug lookup / resume candidate の除外条件にしない。 |
| 2 | [#696](https://github.com/otolab/agents-ensemble/issues/696) | slug を主走査にして clone 横断で list/read/resume 候補を探す。`repoRoot` mismatch 単独では resume を拒否せず、現在の clone で worktree を安全に再利用・再生成する。worktree 衝突や worker ACP restore failure は conductor に通知し、既存 worktree / state を上書きせず、復元不能を成功扱いしない。CLI と core API は `githubRepo` / `--github-repo` または Issue URL で索引する。 |
| 3 | [#697](https://github.com/otolab/agents-ensemble/issues/697) | `operator-agent --repo-root` と `repoRoot` 基準のグループ分けを廃止する。全 slug group が既定、`--repo-filter` で絞り、固有設定は `~/.ensemble/operator-agent/` に置く。会話は global、watch state は slug ごと。Issue session の clone recovery 方針は operator-agent conversation resume を決めない。後者の launch-root 条件は Phase 3 で別途確認する。`--new` は既存会話・transcript を消さず、#698 の移行 tool が利用可能になるまで切り替えない。 |
| 4 | [#698](https://github.com/otolab/agents-ensemble/issues/698) | user path-hash の session / sidecar / tool-call / Pi data、旧 operator-agent conversation / watch / Pi state、列挙された checkout の project-local session data を inventory 付き copy-only で移す。Issue session は `issueUrl` で slug を確定し、`repoRoot` mismatch だけでは除外しない。Store の既存情報を上書きせず、worktree は移行・再生成・削除しない。曖昧・衝突データは checksum / recovery 情報付き archive に保全し、source は削除・rename しない。 |
| 5 | [#699](https://github.com/otolab/agents-ensemble/issues/699) | machine-readable inventory と SHA-256 検証で hash fallback の撤去を判断する。未計上 source、未検証 copy、未記録 collision、operator が archive-only を受け入れていない watch state があれば fallback を外さない。fallback 除去後も root mismatch だけで resume を拒否せず、worktree 再生成・worker restore failure の通知と明示的な失敗を確認する。project-local fallback は完全な checkout inventory と全 source item の検証が揃った場合だけ外す。hash directory は削除しない。 |

## Consequences

- 同じ GitHub repository の session を clone path ではなく一つの slug から発見できる。hash と slug の二重書き込み・location ごとの保存先分岐がなくなり、operator が古い copy を正本として扱う危険を減らせる。
- `repoRoot` / `conductorCwd` は実行環境の記録として保持される。別 clone からの Issue session resume は path mismatch だけでは拒否せず、現在の clone で必要な worktree / worker を復旧する。復旧の有無と失敗を conductor に伝えるため、作業再開を優先しつつ完全復元を装わない。
- Phase 1〜4 では旧 path-hash を残したまま読み、slug に無いファイルだけを複製する。既存データを消さず、衝突時には slug を優先するため、移行を再実行しても hash 側の原本と既存 slug 側の状態を自動上書きしない。別 clone にしか残っていない hash-only session は、Phase 4 の scan が済むまで slug 一覧からは見つからない。
- operator-agent の会話は user scope で維持し、旧 conversation を slug ごとに分割しない。watch state は一意な Issue URL で slug を証明できる単位だけを移す。移行先に通常復元できない曖昧 state は checksum 付きで残るが、watch の再登録後に既存 Open Question が再通知される保証はない。
- Phase 5 後、user path-hash と project-local fallback が gate を通過して終了した場合、移行先にない session は通常検索・watch 再開から見えなくなる。利用者への告知、移行期間、archive からの recovery 手順を用意し、保存 directory 自体は自動削除しない。
- 削除された worktree の未コミット変更や、現在の clone にない commit は自動復元できない。worktree 再生成後はその制約を conductor に伝え、状態確認と不足分の修正を促す。別 worktree・既存 Store の上書きや強制 reset は行わない。

## Open decisions and Phase implementation boundaries

- **Issue session の別 clone resume:** root mismatch だけでは拒否しない方針は operator が確定した。#696 が active clone での worktree / worker recovery、conductor への通知、衝突時の非破壊停止、復元失敗の明示を実装・検証する。worktree 内の未コミット変更など復元できない内容を復元済みと扱わない。
- **operator-agent conversation の別 launch root resume:** これは今回確定した Issue session の方針とは別の判断である。会話 scope は user-global のまま、保存 `repoRoot` は実行 context 属性として保持する案だが、異なる launch root での resume 可否は #697 で引き続き確認する。Issue session と同じ扱いだと推定しない。
- **`--repo-root` 削除の release timing:** operator-agent から flag と repoRoot-based grouping を除く方針は確定した。現在その flag で project config/profile/Pi resources と作業 cwd を選ぶ呼び出しは起動方法を変える必要がある。#697 は removal を major release に合わせるか migration tool と同時に出す別の release boundary を決め、CLI help / release note に変更と移行方法を示す。flag を黙って別の意味に再利用しない。
- **project 設定の移行:** operator-agent 専用の config root は `~/.ensemble/` とするが、session migration script は config files を自動コピーしない。現在 project config/profile/Pi resources にだけある値を user scope へ手動移行する案を #697 の help / docs に載せる。必要な設定 key と、限定的な自動移行を要するかは #697 で確認する。
- **operator-agent の旧 state:** `issueUrl` がない、SessionResumeStore と report の URL が不一致、同じ agent ID の Store / cursor が衝突する場合は slug を割り当てず Phase 4 archive に保全する。conversation は `agentId` 単位でコピーするが、別 launch root から resume できない場合は Phase 5 前に archive-only acceptance を得る。watch が archive のみの場合は既存 question の再通知がない制約を明示し、同じ gate 記録を残す。#698 は migration/recovery format、#699 は gate の検証担当。
- **project-local fallback の終了:** #698 が operator 提供の全 checkout-root inventory を machine-readable report にし、#699 が completeness / checksum / collision / archive acceptance を検証する。全 root の網羅性を確認できなければ read fallback は維持する。作業上の gate は本 ADR で固定するが、実際の checkout inventory が揃っているかは Phase 5 時点の operator confirmation が必要。
- **session read CLI の具体的な option wiring:** `--github-repo` と `--issue-url` の相互検証、および各 read command への適用を #696 で実装・テストする。repository 範囲を `repoRoot` から推測しない境界はこの ADR で固定する。
