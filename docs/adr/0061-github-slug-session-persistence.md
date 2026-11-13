# ADR 0061: Issue session の slug 正本と operator-agent の user profile

- Status: proposed
- Date: 2026-11-13
- Replaces: [ADR 0046](0046-migrated-session-canonical-slug-mirrors.md)（本 ADR の accepted 後、Status のみ superseded に更新する）
- Related: [Issue #694](https://github.com/otolab/agents-ensemble/issues/694), [Issue #695](https://github.com/otolab/agents-ensemble/issues/695), [Issue #693](https://github.com/otolab/agents-ensemble/issues/693), [Issue #696](https://github.com/otolab/agents-ensemble/issues/696), [Issue #697](https://github.com/otolab/agents-ensemble/issues/697), [Issue #698](https://github.com/otolab/agents-ensemble/issues/698), [Issue #699](https://github.com/otolab/agents-ensemble/issues/699)

## Context

ADR 0044 は正規化した `repoRoot` の SHA-256 を repoKey とし、checkout ごとにユーザー層の保存領域を分けた。ADR 0046 は移行後の重複を避けるため canonical slug mirror を導入したが、新規 session の保存先は path-hash のまま残した。そのため slug が正本になるのは一括移行を通った session に限られ、同じ論理 session の JSON や sidecar が複数箇所に残り得る。

重複があると、古い hash copy が選ばれて最新の `harnessSocketPath` を見失うことがある。Issue #607 では hash 側に socket path がなく、slug 側に稼働中 harness の socket path がある事例が報告された。path-hash のままでは同じ GitHub repository の別 clone も別の一覧になり、Issue #691 の operator-agent が既存 session を横断して把握しづらい問題も残る。

現在の [`resolveEnsemblePaths`](../../packages/core/src/ensemble-paths.ts) は `repoRoot` の hash と Issue URL 由来の slug の両方を返す。新規 `conductor-session` は hash 側を初期保存先にし、[`listSessionResumeStoreLocations`](../../packages/core/src/session/session-resume-store.ts) は slug 配下を走査するときも Store 内 `repoRoot` が現在の checkout と一致することを条件にしている。保存先の識別と実行時の checkout が一つのキーに結び付いている。

現行の `operator-agent` も起動場所に依存する。[`run-operator-agent.ts`](../../packages/operator-agent/src/run-operator-agent.ts) は `--repo-root` または `process.cwd()` を使い、[`loadEnsembleConfig`](../../packages/core/src/config/load-ensemble-config.ts) で user config に加えて設定次第で project `.ensemble/config.yaml` を読み、generic team profile を解決する。同じ root が provider の `cwd`、prompt の `repoRoot`、operator state の path-hash、conversation resume 時の一致判定にも使われる。Pi は user resource を読んだ後、[`resolveConductorPiResourcePaths`](../../packages/core/src/config/resolve-settings.ts) が選ぶ project resource（既定 `<repoRoot>/.ensemble/pi`）も読み込む。operator-agent は alpha 未満のため、この CLI 契約を変更できる。新方針では、起動元と project `.ensemble/` を operator-agent の設定・実行根拠から外し、user 共通 config の profile と、その専用 workspace を使う。

移行対象には Issue session だけでなく operator-agent の会話・watch state・Pi transcript もある。旧 operator state は `repoKey` 配下にあり、会話には profile や GitHub slug が記録されていない。watch state には複数 repository の cursor や未 dispatch report が混在し得る。`repoRoot` や会話本文から slug / profile を推測すると、誤った分割や通知の取りこぼしにつながるため、証明できないデータは割り当てず保全する。

## Decision

### Issue session の保存先と `repoRoot`

- 有効な GitHub Issue URL から `github.com/<owner>/<repo>` を得て、owner と repo を小文字に正規化した canonical slug を repository の保存先とする。
- Issue session の user data は `<userEnsembleRoot>/sessions/github.com/<owner>/<repo>/` に保存する。対象は SessionResumeStore、Open Questions / session-state YAML、tool-call history、Pi conductor transcript とする。
- 新規 session、通常 flush、resume 後の更新は canonical slug 配下だけに書く。path-hash への二重書き込みはしない。有効な GitHub repository を決定できない場合、hash を代替の正本にせず、state 変更や backend 起動の前に理由を示して失敗する。
- SessionResumeStore の `repoRoot`、`conductorCwd`、worker の `acpCwd` は作成時の実行 context 属性として残す。`repoRoot` は保存先、一覧、索引の分割キーではない。
- `ensemble issue` では現在の clone の config / team profile / Pi resources と worktree を使う。`<repoRoot>/.ensemble/worktrees/issue-N` の配置規則も維持する。この Issue session の扱いは operator-agent には適用しない。

### 別 clone からの Issue session 再開

- 同じ `owner/repo` の session は slug で一覧・読取・resume 候補に含める。保存 Store の `repoRoot` と現在の `repoRoot` が異なることだけを理由に `--resume` / `--continue` を拒否しない。保存値は診断・復旧情報として使い、実行には現在の clone を使う。
- `issueUrl` / canonical slug と `conductorAgentId` で session を選ぶ。repoRoot mismatch や config digest の違いだけでは事前に打ち切らず、復元可能な範囲で現在の config / backend / worktree を使って再開を試み、差異と復旧できない情報を conductor に知らせる。backend が要求する session identity や設定を満たせず実際に復元できない場合は理由を示し、復元成功と扱わない。
- 現在の clone に対象 Issue の worktree があり、同じ repository / Issue と確認できる場合は再利用する。必要な worktree がなければ警告し、Issue branch が安全に使える場合はそれを使い、使えない場合は通常の新規 worktree と同じ base 解決規則で再生成する。
- 既存 worktree の削除・reset・別 worktree からの branch 強奪はしない。予定 path が別 directory / worktree に使われている場合や branch を安全に使えない場合は上書きしない。別の recovery path を安全に確保できなければ、理由を示して失敗する。
- worktree の再生成では削除済み worktree 内の未コミット変更や、現在の clone にない未 push commit は戻らない。harness は保存 root と現在 root、worktree の再利用 / 再生成 / 解決失敗を conductor に通知する。worker の ACP session を復元できない場合も、対象 worker と状態を conductor に知らせる。古い prompt / tool call を自動再送せず、conductor は branch / status と残存ファイルを確認し、必要なら agent に不足状態の確認・修正を指示して作業を再開する。
- conductor backend 自体を再開できない場合や安全な worktree を確保できない場合は成功と報告しない。復元済み、復旧を伴う継続、復元失敗を区別し、失敗時に既存 Store や別 worktree を新状態で置き換えない。

### 索引 API と session CLI

- core の list API は `{ githubRepo?, issueUrl?, conductorAgentId?, limit?, cursor? }` を受け取り、`{ sessions, nextCursor? }` を返す。`githubRepo` 省略時は user root に保存された全 canonical slug group を走査する。これはローカルに保存された slug の全件であり、GitHub API から repository 一覧を取得する意味ではない。read は `{ githubRepo, issueUrl?, conductorAgentId }` で対象を特定し、resume はこの selector に現在の `repoRoot` を実行 context として加える。list / read の repository scope に `repoRoot` は要求しない。
- read API は対象 repository を `githubRepo` または `issueUrl` で特定する。resume はこの索引 scope に現在の `repoRoot` を実行 context として加えるが、partition key / 候補の除外条件にはしない。
- `ensemble session list` は省略時に全 slug を列挙し、`--github-repo <owner>/<repo>` または `--issue-url <url>` で絞る。`show` / `export` / `messages` / `workers messages` / `timeline` など session ID を読む command は repository scope を明示する。両方を指定して Issue URL の slug が違えば fail fast とし、ID だけから repository を推測しない。

### operator-agent の profile、cwd、設定、状態

- operator-agent 共通 config は `~/.ensemble/operator-agents.config.yaml` とする。operator profile はこのファイルで定義し、選択した profile の workspace / provider cwd は `~/.ensemble/operator-agents/<profile>/` に固定する。profile 名は単一の安全な path segment として検証し、`..` や separator を許さない。
- 起動時の `process.cwd()`、repository の `.ensemble/`、generic team profile（project / user）、generic `~/.ensemble/config.yaml` は operator-agent の設定・prompt・resource・cwd・state 解決に使わない。profile は `operator-agents.config.yaml` だけから読み、generic team-profile resolver / `loadEnsembleConfig` から分ける。選択 profile の workspace がなければ作成し、既存の中身は消さない。operator-agent から `--repo-root` と generic config を選ぶ `--config` を削除する。`ensemble issue --repo-root` は従来どおり clone / config / worktree / resume context の指定に使う。
- profile 選択は `--profile`、config の default profile、唯一の profile、TTY 選択の順で解決する。backend / model / prompt 等の operator 設定は選択 profile と同ファイルの共通設定から解決し、generic Ensemble config の暗黙継承はしない。provider 認証は provider の user-level 認証機構に委ねる。Phase 3 はサポートする環境 override と優先順位を明示し、起動元 repository により値が変わらないことを検証する。
- operator-agent の Pi は generic `resolveConductorPiResourcePaths` が返す project root を使わない。共通 user resource root（既定 `~/.ensemble/pi/`）と、operator profile が明示する profile root（既定 `~/.ensemble/operator-agents/<profile>/pi/`）だけを読む。profile root は通常の Pi project layer として起動 cwd から自動探索せず、profile 設定によって明示する。`<launch cwd>/.ensemble/pi/`、profile workspace 内の `.ensemble/pi/`、そこにある transcript は読み込まない。Pi transcript は `~/.ensemble/operator-agents/conversations/<operatorAgentId>/pi-sessions/` に保存する。
- operator-agent 固有の新規 state は `~/.ensemble/operator-agents/` 配下に置く。conversation record は `~/.ensemble/operator-agents/conversations/<operatorAgentId>/` の global record とし、作成 profile を属性として記録する。watch state は `~/.ensemble/operator-agents/<profile>/watch/github.com/<owner>/<repo>/` のように profile と canonical slug で分ける。新規 state に起動元の `repoRoot` を記録せず、operator state の partition にも使わない。旧 `repoRoot` は migration manifest の source provenance に限り残せる。
- operator profile の設定は operator-agent のみを対象とし、Issue session の config / project profile / worktree 解決を変更しない。

### operator-agent CLI と conversation resume

- CLI の Phase 3 案は `ensemble operator-agent [--profile <name>] [--repo-filter <owner/repo|owner/*>]... [--resume <operatorAgentId>|--new]` とする。operator-agent の `--repo-root` と任意の `--config` path は提供せず、設定ファイルは `~/.ensemble/operator-agents.config.yaml` に固定する。profile 未指定時は config の default profile、設定がなければ唯一の profile を使い、どちらも定まらない場合は利用可能な profile を提示して TTY で選ばせる。
- profile の repository include 設定がなければ全ローカル canonical slug group を対象にする。複数の `--repo-filter` は互いに OR で照合し、profile の include 設定があればその集合との積集合にする。省略時に外部 repository 一覧を取得しない。
- `--resume <operatorAgentId>` は会話を明示選択する。指定がない場合、保存会話が 1 件ならそれを再開し、0 件なら新規作成する。複数ある場合は ID・profile・更新時刻を提示して operator に選んでもらう。新規作成時は ID と再開方法を表示する。`--new` は新 ID の会話を作り、旧 conversation / Pi transcript / watch state / Issue session data を削除しない。
- operator conversation の再開は、起動時の `process.cwd()` や以前の起動場所との違いだけでは拒否しない。新 format は記録された profile の workspace と user-level provider session を使う。profile が存在しない、または明示 `--profile` が記録値と異なる場合は差異を operator に伝え、選択された profile で再開を優先して試す。旧 cwd / resource / transcript など復元できない情報は具体的に通知する。profile-less legacy conversation は `repoRoot` から profile を推測せず、選択または明示指定された profile のもとで best-effort resume を試みる。
- backend が会話を再開できない場合は、その事実と取得できなかった情報を表示し、既存 record / transcript を残す。空の新規会話を同じ ID で作って resume 成功に見せない。再開不可の会話を新しい会話として続ける場合は、別 ID の明示的な `--new` として扱う。
- `list_operator_sessions` は `{ githubRepo?, limit?, cursor? }` を受け取り、省略時は選択 profile の scope に含まれる全ローカル slug group を統合する。応答に `nextCursor?` を含め、利用可能な session を上限で黙って切らない。

### path-hash / project-local fallback と非破壊移行

- Phase 1〜4 の `ensemble issue` session 読取順は canonical slug → 現在の `repoRoot` から導ける user path-hash → project-local legacy とする。path-hash と project-local legacy は互換読取元に限り、新規作成・通常 flush・二重書き込み先にしない。operator-agent は launch cwd / project root を持ち込まず、project-local fallback を直接走査しない。別 clone にしか残らない hash data を含めた横断移行は Phase 4 の責務とする。
- 旧 location から session を読む場合、slug 側に対象 file がないときだけ複製する。slug 側に既存 file があれば slug を正本として採用し、mtime による自動統合や上書きをしない。移行元は削除・rename せず、Phase 5 後も hash directory を自動削除しない。
- Phase 4 #698 の移行 tool は user path-hash の Issue data、旧 `operator-agent/<repoKey>` state、および operator が列挙した checkout の project-local `.ensemble/sessions/` / `.ensemble/operator-agent/` / `.ensemble/pi/sessions/` を inventory 付きで copy-only 移行する。manifest には source path、種別、判定、destination、source / destination SHA-256、collision または archive 理由、recovery 手順を記録する。既存 destination が同一 checksum なら no-op、異なる場合は上書きしない。
- Issue session data は `issueUrl` で slug を証明できる場合だけ対応する group にコピーする。`repoRoot` mismatch は除外理由にしない。worktree 自体は移行・削除・reset しない。
- 旧 operator conversation は repo slug や profile に割り当てない。`agentId` と source provenance を保った global legacy conversation として `~/.ensemble/operator-agents/conversations/<operatorAgentId>/` に profile 未設定でコピーし、旧 `repoRoot` は manifest の出所情報としてだけ残す。新 record の cwd や profile、slug を旧 `repoRoot` から復元しない。Pi backend の record は `agentId` に対応する transcript が一意に確認できる場合だけ同じ conversation にコピーする。異なる内容の同一 ID、破損 record、複数候補または対応を確認できない Pi transcript は選ばず、各 source を `~/.ensemble/operator-agents/legacy/` に checksum 付きで保全する。新 format への import / resume が可能ならその経路を記録する。
- 旧 watch state は `conductorAgentId` ごとの関連 cursor / listener / pending report を一体として扱う。一意な SessionResumeStore `issueUrl` が slug を示し、pending report があればその URL も一致する bundle だけ、operator が profile を選んだ後に新しい profile / slug state へコピーできる形で保全する。移行時点で profile が定まらない bundle、分割・割当の根拠が不足するもの、衝突、破損は source 全体を `~/.ensemble/operator-agents/legacy/` に checksum 付きで保全する。会話本文、`repoRoot`、起動 clone から slug / profile を推測しない。
- 旧 operator config や project config / profile / Pi resource files は session migration の対象にせず、削除・rename もしない。operator-agent は新 config 以外を読まないため、Phase 3 が既存設定から手動で移す項目と影響を利用者向け docs に示す。
- 現行 `migrate-project-ensemble-runtime-to-user.mjs` が project-local source を `rename` する場合、#698 で copy + SHA-256 検証へ改める。source を全 checkout から集められない場合は project-local fallback を終了しない。
- #697 の新 path / config への切替は、#698 の migration tool が利用でき、copy/archive の inventory を作れる状態になってから案内する。alpha の operator-agent は breaking CLI change を許容し、`--repo-root` の互換維持や major release までの延期を前提にしない。help と移行手順で変更を説明する。
- Phase 5 #699 は inventory を検証して user path-hash の read fallback と旧 operator-agent path の自動 read を外す。hash directory / archive 自体を削除する処理ではない。
- **Phase 5 gate:** (1) 全 source item が verified copy、同一 checksum の既存 destination、または checksum / provenance / recovery 手順付き archive に計上される、(2) 未計上 source・未検証 copy・未記録 collision がゼロ、(3) 旧 conversation は profile を選んだ新 path から resume できるか、archive-only として保持・再開手順・operator acceptance が記録される、(4) watch は cursor / pending report まで復元を検証するか、archive-only の場合は silent baseline による既存 Open Question の再通知保証がないことを示して acceptance を得る、を満たす。満たさない間は旧 operator-state fallback を外さない。
- project-local fallback は user path-hash と独立した gate にする。#698 が operator 提供の complete checkout-root inventory を走査し、#699 が全 root と全 source item の copy / archive checksum、collision、recovery 記録を照合した場合だけ終了できる。root inventory が欠ける・検証できない場合は fallback を残す。

### ADR 0046 の扱い

本 ADR が accepted になった時点で、ADR 0046 の「新規 session の通常保存先は path-hash」「移行済み session だけ slug 正本」「session が slug に揃うまで operator-agent state は repoKey を使う」という判断を撤回する。path-hash / project-local legacy の原本を上書き・自動削除しない判断は、Phase 5 までの互換期間と archive の保全方針として引き継ぐ。

ADR 0046 の本文は履歴として書き換えない。本 ADR の accepted 後に ADR 0046 の Status だけを `superseded by [0061](0061-github-slug-session-persistence.md)` に更新する。

## Documentation impact

次の記述は現行コードを説明しているが、本 ADR の設計とは矛盾するため、各 Phase の実装と同じ PR で正本を更新する。Phase 0 では未来の挙動を現行説明へ先取りしない。

| 文書・箇所 | 現在の記述と矛盾 | 更新する Phase |
|---|---|---|
| [session-logging.md — SessionResumeStore と open question YAML](../session-logging.md#4-sessionresumestore-と-open-question-yaml)、冒頭 lifecycle / directory tree | 新規・更新先を `<repoKey>` とし、repoRoot 一致を lookup / resume 条件に使う。slug 保存先、`repoRoot` 属性、slug → hash → project fallback と Phase 5 gate を反映する。 | #693 / #696 / #698 / #699 |
| [session-logging.md — operator state / Pi transcript](../session-logging.md) | operator state を `<repoKey>` 配下に保存し、Pi resources / transcript を repository config と cwd から解決する。global conversation、profile cwd、profile / slug watch path、project `.ensemble/` の除外を反映する。 | #697 / #698 / #699 |
| [live-open-question-control-api.md — Operator-agent watch state](../live-open-question-control-api.md#operator-agent-watch-state-の欠損破損と復旧)、provider history / endpoint discovery | watch / ResumeStore を `<repoKey>` から選び、Pi history の fallback を `conductorCwd/.ensemble` から読む。slug / profile path、移行時の不確実性、Issue session の recovery notice を反映する。UDS wire contract は別途変更が必要な場合を除き維持する。 | #696 / #697 / #698 / #699 |
| [cli/README.md — operator-agent](../cli/README.md) | `--repo-root` / `--config`、暗黙の前回会話再開、repoKey state path を説明する。`--profile`、固定 home cwd、全 slug 既定と filter、会話選択・ID 表示、legacy の扱いを説明する。 | #697 |
| [cli/README.md — session read commands](../cli/README.md) | read command の `--repo-root` を repository scope として使う。`--github-repo` / `--issue-url` の絞り、all-slug list、resume context と index scope の区別、fallback 終了を説明する。 | #696 / #699 |
| [architecture.md](../architecture.md) と [operator-input.md](../operator-input.md) | operator-agent の project cwd / shared team profile、state / watch、resume・復旧報告の現行挙動がある。user profile、conversation selector、slug watch、Issue-session の tolerant recovery を反映する。 | #696 / #697 / #698 / #699 |
| [config.md](../config.md) と [settings.md](../settings.md) — profile / project config / Pi resource roots | operator-agent が起動元 repository の config/profile/Pi project resources を読む前提。`operator-agents.config.yaml` の profile precedence と user-only Pi resources を明記し、`ensemble issue` の project 層は維持する。 | #697 |
| [pi-conductor-setup.md](../pi-conductor-setup.md) — user / project Pi resource roots | operator-agent に project resource root が適用されないこと、profile 固有 Pi resources の置き場所と共通 user auth の範囲を区別する。 | #697 |

## Phase 1〜5 の参照先

各 Phase Issue には本 ADR への直接リンクをコメントで付ける。以下の handoff は Issue 本文・過去コメントのうち矛盾する古い提案を更新する。

| Phase | Issue | この ADR で固定する境界 |
|---|---|---|
| 1 | [#693](https://github.com/otolab/agents-ensemble/issues/693) | Issue session の新規 Store / sidecar / tool-call history は slug のみへ書く。hash と project-local は Phase 1〜4 の read fallback。legacy を読むときは slug 側にない file だけを複製し、source は削除・rename しない。`repoRoot` は属性で、slug lookup / resume candidate の除外条件にしない。 |
| 2 | [#696](https://github.com/otolab/agents-ensemble/issues/696) | API は `githubRepo?` / `issueUrl?` / `conductorAgentId?` で索引し、repo filter 省略時は全ローカル slug を列挙する。session ID read は slug scope を要求する。repoRoot mismatch 単独で resume を拒否せず、現在 clone の worktree を安全に再利用 / 再生成し、再生成・worker restore failure を conductor に通知する。 |
| 3 | [#697](https://github.com/otolab/agents-ensemble/issues/697) | operator profile は `~/.ensemble/operator-agents.config.yaml` に定義し、cwd は `~/.ensemble/operator-agents/<profile>/`。operator-agent の `--repo-root` と repository `.ensemble/` 依存、repoRoot grouping を除く。全 local slug が既定で、profile / `--repo-filter` が scope を狭める。global conversation の resume / select / new、user-only Pi resources、非破壊の failure reporting を実装する。 |
| 4 | [#698](https://github.com/otolab/agents-ensemble/issues/698) | user path-hash Issue data、旧 operator conversation / watch / Pi transcript、列挙 checkout の project-local session data を machine-readable inventory と SHA-256 付きで copy-only 移行する。Issue session は `issueUrl` で slug を証明できるときだけ割り当てる。旧 conversation / watch は slug / profile を推測せず、根拠が足りないものは archive に保全する。 |
| 5 | [#699](https://github.com/otolab/agents-ensemble/issues/699) | inventory の完全性、checksum、collision、conversation resume / archive-only recovery、watch cursor / pending report の復元または acceptance を検証してから hash / 旧 operator-state read fallback を外す。project-local fallback は complete checkout inventory の別 gate で判定する。source directory は自動削除しない。 |

## Consequences

- Issue session は clone path ではなく repository slug から発見される。`repoRoot` は作成時 context として残り、別 clone からの resume を単独では妨げない。削除された worktree 内の未コミット変更や、現 clone にない commit は戻らないため、その欠落を conductor に通知する。
- worktree 再生成時は既存 path / branch / 別 worktree を壊さず、worker restore failure も隠さない。backend が復元できない場合は成功と扱わず、source state を残す。
- operator-agent の設定と実行は repository の `.ensemble/`、起動 cwd、repoRoot hash に左右されない。同一 profile をどこから起動しても provider cwd と user state の scope が一定になる。project にだけあった設定は自動で移らず、元ファイルも変更・削除されない。
- 会話本文の復元が一部欠けても、launch cwd 差だけで resume を止めない。何が欠けたかを伝え、backend が実際に再開できた範囲と失敗を分けて表示する。
- Phase 1〜4 は slug を正本にしながら legacy source を保つ。slug 側が既にあるときは自動統合・上書きをせず、移行は再実行しても既存 data を壊さない。
- Phase 5 で read fallback を外すと archive-only data は通常の一覧・watch から見えない場合がある。inventory、復元手順、operator acceptance を gate にし、hash / archive directory は自動削除しない。

## Open decisions and Phase implementation boundaries

- **Phase 3 の config schema:** `operator-agents.config.yaml` の profile key や provider option の詳細は #697 で定義する。設定の source は同ファイルとし、generic `~/.ensemble/config.yaml` / project config / team profile の暗黙 merge はしない。受け入れ条件として、profile 切替で設定・provider cwd・Pi resources が選択 profile に揃い、同じ profile を異なる launch cwd / repository から起動しても値・resource・state path が変わらないことをテストする。
- **旧 operator conversation の profile:** 旧 state に profile がない場合、`repoRoot` や会話本文から割り当てない。#698 は unassigned legacy record として保全し、#697 は operator が profile を選んで best-effort resume を試せる導線を作る。#699 は再開できない record の archive / recovery 手順と operator acceptance が確認できなければ fallback を外さない。
- **旧 operator watch の profile / slug:** `issueUrl` と関連 report が一意に slug を証明する bundle だけ移す。profile が不明な bundle は自動で新 profile に紐付けない。archive-only の watch を受け入れるときは silent baseline による既存 Open Question の再通知制約を明示する。
- **既存 project-local operator 設定:** `operator-agents.config.yaml` への機械的変換はしない。#697 は backend / model / prompt / Pi resource の手動移行箇所と、以前の project config が以後 operator-agent に反映されないことを help / docs で説明する。session migration の対象と混ぜない。
- **project-local fallback の完全性:** #698 が operator 提供の全 checkout-root inventory を作り、#699 がその網羅性を検証する。全 root を確かめられない場合、Issue session の hash fallback を外す作業とは独立して project-local fallback を維持する。
- **session read CLI scope:** `--github-repo` / `--issue-url` の相互検証と各 read command への適用は #696 で実装・テストする。repository 範囲を `repoRoot` から推測しないことは本 ADR で固定する。
