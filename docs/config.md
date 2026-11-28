# ensemble 共通設定（config.yaml）

> **正本:** `.ensemble/config.yaml` の配置・書き方・スキーマと conductor MCP 設定。本書以外の設定層の一覧・解決パターンは [settings.md](settings.md) を参照します。

`.ensemble/config.yaml` は `ensemble issue` harness の設定の正本。team-profile（`profile.yaml`）や conductor backend の認証とは別系統です。`ensemble operator-agent` はこの設定・team profile を読み込まず、専用の `~/.ensemble/operator-agents.config.yaml` を使います（本書の [operator-agent 設定](#operator-agent-専用設定) を参照）。

conductor の MCP server はこの config.yaml で選択し、定義は別の JSON ファイルで管理する（下記の [Conductor MCP 設定](#conductor-mcp-設定mcpjson) を参照）。

## 配置と解決順

| 層 | パス | 優先度 |
|----|------|--------|
| プロジェクト | `<repoRoot>/.ensemble/config.yaml` | 読み込み有効時に選択された user config を上書き |
| user config（明示指定時） | `--config <path>` | 標準 user config の代わりに user 層として読み込む |
| user config（標準） | `~/.ensemble/config.yaml` | `--config` 未指定時に user 層として読み込む |

- 設定層は **deep merge**（コード内 default → 選択された user config → project config）。project config の読み込みが有効な場合、同一キーは project 側が優先
- `--config` 指定時は `~/.ensemble/config.yaml` を読み込まず、指定ファイルを user 層の代替として扱う
- project config の読み込み可否は選択された user config の `config.loadProjectConfig` で制御する。`--config` は標準 user config の値を引き継がないため、明示ファイルにこのキーがなければ default の `true` が使われる
- `--config` の相対パスはコマンドを実行したディレクトリを基準に解決し、`~` / `~/...` は home に展開する。指定先が存在しない場合は起動エラー
- config ファイルが無い場合は **コード内デフォルト**
- 項目ごとの **環境変数・CLI フラグは、config の各層より優先**

選択された user config の `config.loadProjectConfig: false` を指定すると、project config を読み込まず user 層までで解決します。既定値は `true` です。この制御キーは user 層でのみ有効で、project 側に同じキーを書いても無視されます。`--config` を使う場合は明示ファイル内の値が有効になり、標準 `~/.ensemble/config.yaml` の toggle は読み込まれません。project config を読み込んだ場合は絶対パスを、user 設定でスキップした場合はその旨を起動時に stderr へ表示します。project config が無く、読み込みが有効な場合は表示しません。

`config.loadProjectConfig` は project 層を読むかどうかを選び、`--config <path>` は user 層に使うファイルを選びます。両者は独立しており、明示ファイルを指定しただけでは project config の読み込み可否は変わりません。

### 設定項目ごとの解決順（Phase 1）

すべての Phase 1 キーで次の順序を **実装・テストで固定**している:

```
CLI 明示指定 > 環境変数 > project .ensemble/config.yaml（読み込み有効時） > 選択された user config > コード内デフォルト
```

project 層が無効な場合は、CLI 明示指定 > 環境変数 > 選択された user config > コード内デフォルトで解決します。

一回の起動で user config を切り替える場合は、任意の YAML ファイルを指定します。指定ファイルは標準 user config の代わりに読み込みます。project config は別層として適用され、同じ項目があれば project の値が優先されます（project 層を無効にする場合は、選択された user config で `config.loadProjectConfig: false` を指定します）。

```yaml
# ~/.ensemble/litellm.config.yaml
conductor:
  model: YOUR_LITELLM_MODEL_ID

acp:
  defaultPreset: codex
  env:
    MODEL_PROVIDER: litellm
```

```sh
ensemble issue 42 --config ~/.ensemble/litellm.config.yaml
```

token などの秘密情報はこのファイルへ平文で書かず、provider が参照する環境変数や認証ストアで管理します。

`loadEnsembleConfig(repoRoot, { configPath })` はコード内 default → 選択された user config → project config（読み込み有効時）の順で merge した `EnsembleConfig` を返します。`configPath` がなければ標準 user config を user 層として使います。明示指定ファイルにない項目はコード内 default から引き継ぐため、標準 user config の値は漏れません。`config.loadProjectConfig` は選択された user config から解決し、明示ファイルにも指定できます。project config 内の同名キーは無視されます。各 `resolve*Setting` はその merged config を **config 層**として参照します。

`conductor.backend` はこの共通順序の例外です。CLI / 環境変数による上書きはなく、選択した profile の `profile.conductor.backend` > merged config（project > 選択された user config）> `pi` の順で解決します。Cursor SDK を使う場合は config または profile に `backend: cursor` を指定してください。

`ensemble issue` は GitHub monitor / Issue コンテキスト取得より前に config を読み込みます。`ensemble operator-agent` は専用 config を読み、`--config <path>` で選択できます。この指定に対応する環境変数は設けていません。`--profile` は選択した config 内の profile を選びます。

## operator-agent 専用設定

operator-agent は既定で `~/.ensemble/operator-agents.config.yaml` を読みます。`--config <path>` を指定すると、そのファイルだけを読み込みます。path は起動時の current working directory を基準に解決し、`~` / `~/...` はユーザ home に展開します。明示したファイルが存在しない場合は起動エラーです。

既定 config の state は従来どおり `~/.ensemble/operator-agents/<profile>/` に保存します。明示指定した config が既定 config と同じ実ファイル（相対・絶対 path や symlink の別名を含む）なら、この legacy directory を共有します。それ以外の config は、`realpath` で得た config file path の SHA-256 を識別子にして `~/.ensemble/operator-agents/.config-scopes/<hash>/<profile>/` を使います。識別はファイル内容ではなく canonical path に基づきます。同じ内容の別ファイルは別 namespace になり、hard link も別 path なら別 namespace です。namespace directory は profile 名として使えない隠し名にしており、既存の有効な profile 名と衝突しません。workspace、watch state、scheduling events、およびそれらの lock はこの namespace に属します。profile 名は安全な単一 path segment でなければなりません。

相対 Pi path は共通設定なら `~/.ensemble/`、profile の `pi.projectDir` なら選択 workspace を基準にします。既定 config の path と namespace は従来のままなので、既存 workspace の内容も同じ場所から引き続き利用されます。

```yaml
version: 1
defaultProfile: personal
common:
  conductor:
    backend: pi
    model: default
    reasoning: high
  pi:
    agentDir: ~/.ensemble/pi
profiles:
  personal:
    include:
      - otolab/*
    conductor:
      model: YOUR_MODEL_ID
    prompt:
      instructions:
        - Review saved sessions across the selected repositories.
    pi:
      projectDir: pi
      skills: true
    mcp:
      servers:
        - github-read-only
```

profile workspace 直下の `AGENTS.md` は起動時に読み、system prompt の基本指示、profile の `prompt.instructions` に続けて追加します。両方とも指示として扱い、後者だけが前者を置き換えることはありません。起動元 repository・cwd・`~/.ensemble/AGENTS.md` は読みません。ファイルがない場合や空白だけの場合は追加せず、`AGENTS.md` の symlink はリンク先にかかわらず拒否します。読み込みエラーや不正な UTF-8 は path を示して起動を失敗させます。

実行中の変更は反映されず、再起動または resume 時に読み直します。Pi の resume では system prompt を差し替えます。Cursor の resume では起動後の最初の送信の先頭に現在の system prompt を付けるため、会話履歴に残ります。

#### operator-agent の scheduler 設定

report の集約・選択・focus 用設定は `common.scheduling` に置き、profile で上書きする場合は `profiles.<name>.scheduling` に同じ項目を指定します。profile の値は項目ごとに common の値を上書きします。watch の `pollIntervalMs` / `debounceMs` や conductor message listener の `messageDebounceMs` は、それぞれの watch / listener に属する既存設定で、scheduler の設定とは独立しています。

```yaml
version: 1
common:
  scheduling:
    batchMaxWaitMs: 30000
    pushThreshold: 10
    sessionStateWeight: 1
    openQuestionWeight: 10
    conductorMessageWeight: 5
    idleCandidateWeight: 1
    idlePhaseThresholdMs: 1800000
    staleRunningThresholdMs: 3600000
    idleAgingMs: 300000
    focusInactivityTimeoutMs: 600000
    idleReevaluationIntervalMs: 60000
profiles:
  personal:
    scheduling:
      batchMaxWaitMs: 45000 # この profile だけ 45 秒にする
```

時間の値は整数ミリ秒です。重みと閾値は単位のない整数です。batch max-wait の default / 範囲、focus timeout の10分 default、idle aging の5分 default、idle-phase の30分 threshold、running の60分 threshold は operator が決めた試用条件です。

| 項目 | default / 許容範囲 | 意味と調整した場合の効果 |
|------|--------------------|--------------------------|
| `batchMaxWaitMs` | 30,000 / 10,000–120,000 ms | 重みの閾値到達後、quiet window と比較する待機上限。閾値未満の batch は経過時間だけでは自動配送されない。send / dispatch の期限ではない。 |
| `pushThreshold` | 10 / 1–10,000 | 同一 session の batch を自動配送する累積重みの閾値。 |
| `sessionStateWeight` / `openQuestionWeight` / `conductorMessageWeight` / `idleCandidateWeight` | 1 / 10 / 5 / 1、各 0–10,000 | report 種別ごとの重み。値を増やすと閾値に早く達する。 |
| `idlePhaseThresholdMs` | 1,800,000 / 600,000–7,200,000 ms | `harnessPhase=idle` かつ最後の harness state update からの経過時間。`modifiedAt` は idle phase の開始時刻そのものではなく、直近の harness activity / phase transition 時刻。30 分 default は operator 決定。短いと候補が早まり、長いと通知頻度が下がる。 |
| `staleRunningThresholdMs` | 3,600,000 / 1,800,000–14,400,000 ms | 現在 `running` の session で、最後の statusLine 報告からこの時間以上たった場合の確認候補。statusLine の時刻を最終 status update の proxy として使う。候補は異常・停止の判定ではない。 |
| `idleAgingMs` | 300,000 / 60,000–1,800,000 ms | eligible な idle-only batch が通常 FIFO 帯へ昇格するまでの時間。短いと通常 report の後に早く選ばれ、長いと低 priority の期間が延びる。上位 priority、hold、停止を越える dispatch deadline ではない。 |
| `focusInactivityTimeoutMs` | 600,000 / 180,000–1,800,000 ms | 最後の operator / user 入力から測る focus の sliding failsafe timeout。短いと focus が早く解除され、長いと人間入力が止まった focus が続く。通常は人間応答待ちに入る際に手動で切り替える / 解除する。 |
| `idleReevaluationIntervalMs` | 60,000 / 30,000–300,000 ms | idle candidate の再評価 cadence。短いと条件成立後の候補化が早まるが評価回数が増え、長いと評価負荷が減る一方で候補化が遅れる。gate 解除時の一回再評価とは別の時計。 |
| gate-clear candidate refresh wait cap | 1,000 ms / 固定 | gate 解除後、fresh observation と candidate admission を待つ上限。全 watch session を順に調べる pass 全体で1秒。境界後に完了する通常 watch poll があれば再利用し、なければ candidate-only UDS read を行う。上限内に候補が scheduler に入れば OQ と同じ send にまとめられる。上限到達または refresh failure 後は ready OQ をそれ以上 refresh 待ちさせず、遅い candidate は後続 batch に残す。調整可能な設定ではない。 |

`batchMaxWaitMs` は閾値到達時から測ります。#745 の候補 cadence や idle aging とは別の時計です。

idle candidate の評価時計、gate-clear refresh wait cap、`batchMaxWaitMs` は別です。`idleReevaluationIntervalMs` は watch pool の観測値から候補条件を再評価する間隔、`idlePhaseThresholdMs` / `staleRunningThresholdMs` は候補条件を満たすまでの時間です。gate-clear cap は OQ を fresh candidate observation と admission のために待たせる最長時間で、watch session 数にかかわらず一 pass に一度だけ適用します。gate clear 時点で freshness boundary を取り、後から完了する通常 poll があればその結果を再利用し、なければ candidate-only UDS read を行います。cap 後も進行中の refresh は続き、candidate は後から shared scheduler に admission され得ます。同一 send は保証されず、cap は end-to-end 配送期限でもありません。既存の通常 poll が profile state lock を保持している場合、refresh cap とは別に `commitBatch` の lock 待ちが OQ を遅らせることがあります。候補が共有 scheduler に durable に受け入れられた時点で `eligibleAt` が記録され、idle-only batch の5分 aging が始まります。`batchMaxWaitMs` は重みが閾値に達した session batch の ready 待機上限で、候補を作る時刻や実際の `agent.send` を保証しません。手動 report hold 中も idle aging は進みますが、hold 中は送信しません。

候補の対象は選択中 profile で自動発見または明示 watch された session です。現在の候補評価には一意な SessionResumeStore、reachable な live UDS observation、観測時点と矛盾しない保存 `harnessPhase` / `modifiedAt` が必要です。poll 時に phase state を再読込し、観測前後で phase / timestamp / lifecycle が変わっていた場合はその回を unknown として候補を作りません。live observation は watch ごとの polling 間隔の2倍以内（最低10秒以内）を fresh とします。UDS が到達不能、状態が stale / 欠落 / 矛盾、phase が terminal または不明の場合は安全側に候補を出しません。

`harnessPhase=idle` は保存された harness phase であり、worker の完了・停止・作業未完了を示しません。idle candidate は「確認候補」として扱います。idle threshold は `harnessPhase=idle` と確認できた状態で `modifiedAt`（最後の harness activity / phase transition 時刻）から測ります。これは phase transition 専用時刻ではないため、別の harness state write があれば起点が新しくなることがあります。`running` candidate は live UDS observation で現在の保存 phase が `running` と確認でき、statusLine の `reportedAt` が stale-running threshold 以上前の場合に作ります。statusLine が現在の running phase より前の報告でも「最後の statusLine 報告」として扱います。worker progress heartbeat は取得できないため、通知には最後の statusLine と時刻を示し、worker progress の直接観測ではないことを明記します。実作業の進捗を statusLine に対応づける正確な signal mapping は未解決で、この機能では最終 status update の proxy としてのみ使います。statusLine 欠落や future timestamp は候補根拠として使いません。正常な長時間処理や user / worker の一般的な待ちを停滞と推定せず、live Open Question があることだけでは candidate を抑止しません。現行 observation に一般的な user-wait signal はなく、OQ は live question の有無だけを示します。

observable conversation / focus gate は operator dispatch の freeze / `agent.send` 中、送信済み operator input の pending、operator conversation hold、active focus です。gate 中は候補を生成・scheduler に登録せず、解除時は watch 対象ごとに freshness boundary を取り、境界後に完了する通常 poll があれば再利用し、なければ candidate-only UDS read を一度行って現在条件を再評価します。gate-clear refresh wait cap は1秒を pass 全体に適用し、idle 再評価 cadence と `batchMaxWaitMs` とは別です。上限後の OQ と candidate の同一 send は保証されず、この cap は配送期限でもありません。gate 中に threshold を越えた session は蓄積せず、解除後の確認時点で条件を満たすものだけが候補になります。typed-but-unsubmitted TTY input や一般的な worker wait は観測できません。手動 report hold は別の dispatch gate で、候補の生成・scheduler admission と aging を止めません。Open Question だけでも candidate は抑止しません。

idle phase の fingerprint は session と `modifiedAt`、stale-running fingerprint は session・現在の harness state update 時刻・statusLine text / `reportedAt` から作り、durable watch state に保持します。同じ根拠の周期的な再通知は行いません。根拠が変われば新しい candidate が作られる場合があります。ack 後や operator-agent の再起動後も fingerprint は維持し、pending report の ID / retry / ack は既存の shared scheduler lifecycle を使います。process 停止・ack retry exhaustion・restart replay では既存契約どおり at-least-once により同じ report ID が再配送される可能性があります。

candidate は既存の session report queue / batch / hold / retry / ack 経路を使います。live OQ report と idle candidate が dispatch 前に同一 session の queue に揃っている場合、到着順を保った同じ batch / send に含み、batch priority は Open Question を保ちます。通常 report と idle candidate の混在 batch は通常 priority となり、idle candidate が早く同梱される場合があります。OQ は focus 解除 signal には使いません。

`commitBatch` は profile lock を取得してから dispatch eligibility を再確認し、ローカル queue に届いた同一 session report を含めて batch を凍結します。ローカル queue への到着が lock 待ち中であっても、成功する commit より前なら batch に含まれます。共有 state に保存されていても、この process の queue にまだ同期されていない peer report は次 batch に残ります。その場合も report を保持し、後続 batch で session 内の順序を守ります。

#### 検証範囲と待ち時間の比較

[場面別の比較 test](../packages/operator-agent/src/dispatch/operator-idle-candidate-scenarios.test.ts) は、同じ fake-clock timeline を baseline（idle candidate なし）と統合後（条件を満たす candidate を登録）で再生します。実 `OperatorDispatchQueue` と fake `agent.send` を使います。ここで dispatch は選択された user/report batch、report batch は distinct な frozen `batchId`、turn は fake `agent.send` 呼び出しです。失敗した send retry も turn proxy に数えます。重要通知の待ち時間は OQ の投入から、それを含む最初の成功 send までです。

この場面表は `OperatorDispatchQueue` の実 `selectBatch` / `commitBatch` を直接呼ぶ synthetic harness で、`agent.send` は fake です。selector の規則を同じ fake-clock timeline で比較しますが、watch pool や run loop の非同期競合を再現するものではありません。実 `runOperatorAgent` を通す比較は別の [run-loop integration test](../packages/operator-agent/src/dispatch/operator-idle-run-loop.test.ts) で行います。後者は手動 watch の比較条件を保つため自動発見を無効にし、push 閾値を1に設定しています。どちらも実 provider の待ち時間・turn 数を測るものではありません。

状態不変の行は実 watch pool も通します。同じ stale-running evidence を4回 UDS observation し、実 `enqueueIdleCandidate` の durable fingerprint gate が candidate を一度だけ受け付けることを確認します。OQ のみの baseline と統合後は、ともに1 dispatch / 1 report batch / 1 fake turn、OQ 待ち3,000 msです。

| シナリオ | baseline dispatch / report batch / fake turn・OQ 待ち | idle 統合 dispatch / report batch / fake turn・OQ 待ち | 観測した差 |
|---|---:|---:|---|
| 複数 session。別 session の OQ と、通常 report に同梱できる idle candidate | 2 / 2 / 2・0 ms | 2 / 2 / 2・0 ms | candidate が同じ session の通常 report に hitchhike し、turn は増えない |
| 50分動いているが statusLine は5分前の正常処理 | 1 / 1 / 1・0 ms | 1 / 1 / 1・0 ms | stale-running candidate を作らず、turn は増えない |
| 同じ stale-running evidence を4回再評価し、状態が変わらない | 1 / 1 / 1・3,000 ms | 1 / 1 / 1・3,000 ms | fingerprint が同一のため candidate は1件だけ OQ と同梱され、追加 turn / OQ 待ちはない |
| pending operator input の gate 中に到着した OQ | 2 / 1 / 2・1,000 ms | 2 / 1 / 2・1,000 ms | input を先に送り、gate 解除後の candidate は OQ batch に同梱 |
| gate-clear refresh が1秒を超え、OQ send 後に candidate が届く | 2 / 1 / 2・10,050 ms | 3 / 2 / 3・10,050 ms（fake clock） | baseline は refresh failure、統合後は cap で OQ-only を先に送り、candidate の独立 batch で1 turn増。wait-cap timer の1秒は fake `Date.now()` を進めないため表の待ち時間には含めない |
| focus session を処理し、focus を切り替えてから解除 | 2 / 2 / 2・2,000 ms | 2 / 2 / 2・2,000 ms | focus 中は candidate を入れず、解除後に OQ と同じ batch へ追加 |
| 5分間の manual hold | 1 / 1 / 1・300,000 ms | 1 / 1 / 1・300,000 ms | hold による遅延は両方に等しく、解除後は OQ と同梱 |
| 通常 report が続く5分 aging 境界。idle 候補2件と OQ・通常 report が同時 ready | 6 / 6 / 6・0 ms | 8 / 8 / 8・0 ms | OQ は先に送り、aged idle は arrival order で通常 FIFO 帯へ進む。2件分の追加 turn が発生するが OQ 待ちは増えない |
| OQ + candidate の send retry、restart replay、ack retry | 2 / 1 / 2・5,000 ms | 2 / 1 / 2・5,000 ms | 同じ frozen batch を再送。ack retry では send / turn を追加しない |
| profile-lock wait 中に local OQ が到着し、peer report は未同期 | 2 / 2 / 2・50 ms | 2 / 2 / 2・50 ms | local OQ は commit 時の同じ send、peer report は次 batch。dispatch 数は同じ |
| stale-running candidate が OQ と別 session にあり、同梱できない | 1 / 1 / 1・0 ms | 2 / 2 / 2・0 ms | candidate の独立 send で1 turn増えるが、OQ の待ちは増えない |

lock-wait の比較は選択から commit まで100 ms、OQ 到着から commit まで50 msに固定しています。peer report は commit 時点で process-local queue に未同期として扱い、次 batch に残します。これらの数値は queue / fake-send harness による再現可能な合成比較であり、実 provider の send / turn 数や実環境の通知時間ではありません。別の `operator-watch-pool` integration test は SQLite profile lock の待機中 append、durable frozen batch、未同期 peer の後続 batch、retry / restart / ack を検証しますが、実運用レイテンシを測りません。

複数 session、同じ evidence の反復評価、focus 切替、user input と conversation gate、正常な長時間処理、stale-running、manual hold、retry / restart / ack、#755 commit boundary を fixture / scheduler / integration test で確認します。実 provider / 複数 conductor / TTY の運用計測は行っていません。agent の処理時間、人間の応答、process 停止や上位 priority の継続に対する有限通知時間も保証しません。

`runOperatorAgent` を通す fake-clock / fake-agent 比較の通常完了ケースでは、3 session を同じ user-send gate 中に watch し、baseline / idle 統合後とも 4 dispatch（user input と3 report batch）、3 report batch、4 fake turns、OQ 待ち10,050 msでした。OQ は10秒の user-send gate 中に到着し、gate 解除後の fresh UDS refresh に合成50 msを加えています。統合後は OQ と同一 session の idle candidate、および別 session の通常 `session_state` report と idle candidate が、それぞれ同じ batch に入りました。OQ は一度だけ到着順どおりに含まれ、OQ priority を維持しました。最後の statusLine が5分前の `running` session には stale-running candidate を作らず、baseline と同じ通常 report だけを送りました。idle candidate 2件は既存 report に同梱されたため追加 turn はありません。

同じ run-loop harness で question session の gate-clear UDS read を barrier で cap 後まで止めると、OQ-only batch が先に send され、barrier 解除後の同 session candidate は後続 batch に一度だけ入りました。late fixture は1 sessionだけを watch し、baseline は refresh failure で2 dispatch / 1 report batch / 2 fake turns、統合後は3 / 2 / 3です。後者は candidate の追加 turn が1回あります。両方の `openQuestionWaitMs=10,050` は fake clock 上の値で、user gate 10秒と合成50ms read-start までを表し、実 timer の1秒 cap は含みません。別の fake-timer test は、3 watched session の順次 poll のうち先頭 failure と後続二つの700ms readを再現し、全 pass の待機が1,000msで切れ、残りの candidate が1,400ms時点で一度ずつ admission されることを確認します。run-loop test は OQ が barrier 解放前に send される順序を確認しますが、provider latency や実運用の壁時計計測はしていません。

もう一つの run-loop regression は、OQ が live / pending のまま同一 session の通常 watch poll が gate clear をまたいで進行中の場面です。進行中の poll と合流し、その開始時刻が10秒を超えて古い場合は完了後に重複しない追加 read を行います。candidate を一度 admission し、OQ と同じ batch/send にまとめます。比較 fixture の値は2 dispatch / 1 report batch / 2 fake turns、OQ 待ち10,150msです（user gate 10秒 + 合成100ms + 追加 read の50ms）。実 UDS latency の測定ではありません。

これらの run-loop 比較も再現可能な合成試験です。50ms は固定した fake refresh delay、1秒は policy timer を使う上限です。実 provider の latency、複数 conductor の同時負荷、OS scheduling、TTY 操作時間は測定していません。fresh candidate read は UDS 待ちの間 profile state lock を保持しないため、#741 の `commitBatch` / append cutoff は変更しません。ただし他の profile lock owner、ready batch の commit、hold、retry、agent.send、停止が OQ を遅らせる可能性は残り、gate-clear cap は OQ の global delivery deadline ではありません。状態が unknown、refresh が失敗、または fresh evidence が候補条件を満たさない場合は候補を作らず、古い observation のまま待ち続けません。aging 境界での継続する通常 report に対する非飢餓、同順位の FIFO、gate refresh / append / retry / restart をまたぐ `eligibleAt` と到着順の保持は selector / watch-pool integration tests で確認します。上位 priority、hold、停止、provider の長い処理が続けば通知は遅れ得ます。5分 aging は通常 FIFO 帯へ昇格させますが、有限時間内の送信を保証しません。

profile は `--profile` > `ENSEMBLE_OPERATOR_AGENT_PROFILE` > 再開対象 conversation に記録された profile > `defaultProfile` > 唯一の profile の順に選びます。暗黙の保存 conversation 選択では現在の config namespace に属する record だけを候補にし、旧 record（config scope の記録がないもの）は既定 config のものとして扱います。`--resume <operatorAgentId>` は明示選択なので config をまたいで global record を指定でき、その起動では現在選択した config / profile で復元を試します。record の再保存後は選択中 namespace に属します。まだ複数 profile 候補が残る場合は TTY で選択します。保存 conversation の profile が config から消えていて選び直す場合は、その差を表示します。

`backend` / `model` / `reasoning` は `ENSEMBLE_OPERATOR_AGENT_BACKEND` / `ENSEMBLE_OPERATOR_AGENT_MODEL` / `ENSEMBLE_OPERATOR_AGENT_REASONING` > 選択 profile > `common.conductor` > 既定値の順です。operator-agent は `CONDUCTOR_*`、generic config、project config、team profile から値を継承しません。Pi 共通 root は `common.pi.agentDir` > `PI_CODING_AGENT_DIR` > `~/.ensemble/pi`、profile root は `profiles.<name>.pi.projectDir` > `<profile workspace>/pi` の順です。config 既定の profile root は config ごとに分かれますが、明示した absolute root や同じ relative `common.pi.agentDir`、`PI_CODING_AGENT_DIR` は config 間で共有されます。Pi がその root 内の設定・認証・resource file を更新する場合、異なる config の実行同士は同じ Pi root を共有し競合し得ます。Pi は指定した user root と選択 profile root のみを読み、launch cwd や profile workspace から `.ensemble/pi` を自動探索しません。

会話 record と Pi transcript は引き続き `operatorAgentId` ごとの global 保存です。別 config から同じ ID を同時に `--resume` すると transcript や provider session の共有資源を並行利用し得ます。config namespace の watch / workspace lock は会話 ID や明示共有した Pi root を直列化しないため、同じ会話 ID の同時 resume は避けてください。

#### operator-agent の MCP 選択

operator-agent は profile ごとに `mcp.servers` で MCP server 名を選びます。定義は `~/.ensemble/mcp.json` から選択名の分だけ読み込み、起動した repository の `.agents/mcp.json` や `.ensemble/` は参照しません。profile の `mcp.servers` があれば `common.mcp.servers` 全体を置き換え、未指定なら common の選択を使います。profile に `servers: []` を指定すると common の選択も無効になります。どちらにも選択がなければ `mcp.json` 自体を読みません。

この operator-agent 固有の選択方針は [ADR 0077](adr/0077-operator-agent-mcp-server-selection.md) に記録しています。Issue conductor の MCP 解決には適用しません。

```yaml
version: 1
common:
  mcp:
    servers:
      - coeiro-operator
profiles:
  personal:
    mcp:
      servers:
        - github-read-only
```

この例では `personal` profile は GitHub server だけを使い、それ以外の profile は common の `coeiro-operator` を使います。`~/.ensemble/mcp.json` に定義しただけでは MCP server は起動しません。選択された定義だけが operator conductor の起動・resume・reconnect 時に backend へ渡されます。選択名が定義されていない場合は、server 名と設定ファイルの場所を含むエラーで起動を止めます。

Cursor SDK backend は SDK が受け付ける stdio / HTTP / SSE を使います。Cursor には `local.settingSources: []` を渡すため、SDK は明示した inline MCP server のみを読み込みます（[Cursor SDK の設定 source](https://cursor.com/docs/sdk/typescript#what-gets-loaded)）。Pi backend は stdio と Streamable HTTP を使い、Pi 公式 MCP extension が未対応の SSE は server 名を含むエラーにします。`${env:NAME}` は operator process の環境変数、`${workspaceFolder}` と `${workspaceFolderBasename}` は選択 profile の workspace（既定 config では `~/.ensemble/operator-agents/<profile>/`）へ展開します。未定義の環境変数は、値をそのまま渡さず server 名・項目名とともにエラーにします。トークンなどの値は config に直接書かず、権限を絞った環境変数で渡してください。

Pi backend の operator-agent は、選択した各 server の MCP tool を [Pi 1.6.1 の MCP extension](https://github.com/earendil-works/pi/blob/v1.6.1/packages/coding-agent/docs/mcp.md) の `direct` exposure で公開します。server が提示する tool は `mcp__<server>__<tool>` 名（名前の変換後に衝突または長さ制限がある場合は hash suffix 付き）でモデル向け tool declaration に載り、Pi の通常の tool call 経路で実行されます。server が提示する全 tool が対象なので、read-only が必要なら server 側の read-only mode と認証権限を設定してください。operator-agent の Pi 経路では Codemode extension を登録しないため、JavaScript 実行 tool と `models.*` API は利用できません。Pi の MCP `resources` は server が提供していれば `list_mcp_resources`、`list_mcp_resource_templates`、`read_mcp_resource` で公開されます。Pi 1.6.1 の MCP extension は MCP `prompts` を公開しません。Pi 1.6.0 では resume / reload 後に MCP extension の tool が失われる問題も修正されています。

Pi は初回 prompt の前に direct tool server の接続を最大 10 秒待ちます。direct MCP text result が 20 KiB を超えると、Pi はモデル向け本文を中央で切り詰め、全体を一時ファイルに保存した path を結果へ含めます。operator-agent には一般的な filesystem reader がなく、workspace file tool も active profile workspace 内に限定されるため、その一時ファイルを必ず読み戻せるとは限りません。大きな結果は server 側で検索・ページングして取得してください。

MCP server は接続先の認証情報と server process / service が持つ権限で処理します。profile で選択した server の限定は server 単位で、Pi の direct exposure 自体は tool の副作用を制限せず、workspace file tool の path 検査も MCP server には適用されません。ローカル stdio server は operator と同じ OS user で動き、HTTP server は渡された token の権限で操作します。MCP は一般的な OS sandbox ではないため、信頼できる server と最小権限の認証情報を選んでください。

##### GitHub official MCP server（read-only）

GitHub official MCP server は stdio で起動し、Issue と Pull Request の read/list/search を使えるよう `issues,pull_requests` toolset を選びます。`GITHUB_READ_ONLY=1` は toolset に書き込み系 tool が含まれる場合も read-only で除外する server 側の制御です。

`~/.ensemble/mcp.json`:

```json
{
  "mcpServers": {
    "github-read-only": {
      "type": "stdio",
      "command": "docker",
      "args": [
        "run",
        "-i",
        "--rm",
        "-e",
        "GITHUB_PERSONAL_ACCESS_TOKEN",
        "-e",
        "GITHUB_TOOLSETS",
        "-e",
        "GITHUB_READ_ONLY",
        "ghcr.io/github/github-mcp-server"
      ],
      "env": {
        "GITHUB_PERSONAL_ACCESS_TOKEN": "${env:GITHUB_PERSONAL_ACCESS_TOKEN}",
        "GITHUB_TOOLSETS": "issues,pull_requests",
        "GITHUB_READ_ONLY": "1"
      }
    }
  }
}
```

利用する profile に `mcp.servers: [github-read-only]` を設定し、起動環境に token を用意します。token は対象 repository だけに限定した fine-grained PAT を推奨します。Issue と Pull Request を読むだけなら、対象 repository に対して `Issues: read` と `Pull requests: read` を付与し、書き込み権限は追加しません。GitHub MCP server の read-only mode は tool の公開を絞りますが、GitHub 側の token 権限も同じ範囲に絞ってください。詳細は [GitHub MCP server の read-only 設定](https://github.com/github/github-mcp-server/blob/main/docs/server-configuration.md#read-only-mode)、[toolset 設定](https://github.com/github/github-mcp-server/blob/main/docs/server-configuration.md#enabling-specific-toolsets)、[fine-grained PAT の権限と制限](https://docs.github.com/en/authentication/keeping-your-account-and-data-secure/managing-your-personal-access-tokens)を参照してください。

##### coeiro-operator

[coeiro-operator の MCP server](https://github.com/otolab/coeiro-operator/blob/main/packages/mcp/src/server.ts) は `StdioServerTransport` で接続する実装です。MCP 接続自体に HTTP token や OAuth は要求せず、`npx -y --package @coeiro-operator/mcp coeiro-operator` で起動できます。音声合成は別途ローカル COEIROINK を必要とし、公開設定ガイドでは `localhost:50032` を接続先、`~/.coeiro-operator/config.json` を利用者設定として案内しています。利用可能な tool には `say`、operator の割当・解放、辞書登録などが含まれます。書き込みや音声出力を伴う操作もあるため、使う tool とローカルサービスの権限を確認して選択してください。詳細は [coeiro-operator README](https://github.com/otolab/coeiro-operator) と[設定ガイド](https://github.com/otolab/coeiro-operator/blob/main/docs/user-guide/configuration-guide.md)を参照してください。

```json
{
  "mcpServers": {
    "coeiro-operator": {
      "type": "stdio",
      "command": "npx",
      "args": ["-y", "--package", "@coeiro-operator/mcp", "coeiro-operator"]
    }
  }
}
```

この経路はローカルの模擬 stdio MCP server で tool discovery / call / close を確認しています。COEIROINK の実機と coeiro-operator package を使った接続・音声出力はこの作業環境では未確認です。

profile の `include` は `owner/repo` または `owner/*` の repository pattern 配列です。未指定または空なら scope を狭めません。CLI の複数 `--repo-filter` は OR で照合し、指定した `include` との AND を取ります。対象は user store にある session data で、GitHub API から repository を列挙しません。

#### resume と config 変更

新しい session は SessionResumeStore に `ensembleConfigDigestScheme: resume-feasibility` と digest を記録します。この digest が要約するのは merge 後の `session.worktree`、`acp.defaultPreset`、`acp.pi.runtime` です。BYO は既定値として省略し、従来の設定 digest を変えません。resume は保存時の clone / config / profile を復元せず、現在 clone で解決した設定を使います。digest 差だけで resume を拒否しません。実際の backend / ACP が session を復元できない場合は、その失敗を通知します。Pi runtime の切り替え後に builtin Pi の保存 session を読み込めない場合は、新規 session へ黙って置き換えず worker attach を失敗させます（[ADR 0048](adr/0048-session-resume-feasibility-config-digest.md)、[ADR 0067](adr/0067-pi-acp-upstream-package-wrapper.md)）。

`acpModelConfigDigest` は `acp.env` / `acp.models` / `acp.tags` を hash し、worker の ACP spawn fingerprint は `piRuntime`、`modelTag`、解決済み model ID、reasoning、明示値の `cursorFast`、spawn env digest と Codex の実効 `MODEL_PROVIDER` digest を記録します。秘密の環境値は平文で保存しません。これらは保存時の設定を説明する診断情報です。resume 時は現在の preset / runtime / command / args を使って `session/load` を試み、保存 fingerprint の差だけで先に拒否しません。load failure 後に新しい ACP session へ復旧する runtime では、旧 session の文脈を復元できなかったことを operator と conductor に通知します。中断した古い instruction は自動再送しません（[ADR 0054](adr/0054-cursor-acp-runtime-verification.md)、[ADR 0067](adr/0067-pi-acp-upstream-package-wrapper.md)）。

`conductor.model` と `conductor.reasoning` は `resume-feasibility` digest の対象外です。これらの config 値を変えても Issue session の resume は拒否されず、再開時に現在の merged config を使います。Issue session の `--model` / `--reasoning` と `CONDUCTOR_MODEL_ID` / `CONDUCTOR_REASONING` は digest に含めず、resume ごとに再解決します。operator-agent は別の専用 config と `ENSEMBLE_OPERATOR_AGENT_MODEL` / `ENSEMBLE_OPERATOR_AGENT_REASONING` を使います。

conductor model の優先順は `--model` / `RunConductorSessionOptions.modelId` > `CONDUCTOR_MODEL_ID` > merged config の `conductor.model` > backend default です。直接 API でも同じ優先順で選択し、Cursor / Pi の組み込み factory には解決値を create / resume 時に渡します。既定の `model: default` は Pi では特別なモデル ID として送らず、Pi resource settings の `defaultProvider` / `defaultModel`（`model` / `modelId` alias も可）に選択を委ねます。設定がなければ明示 model を指定するか、初回導線の `ensemble setup` で Pi model settings を用意してください。custom factory では互換性を保つため、config または code default から `default` が選ばれた場合は `modelId: undefined` を渡し、factory 自身の既定値に委ねます。一方、CLI / API の明示値または `CONDUCTOR_MODEL_ID` が `default` / `auto` を選んだ場合は `'default'` を渡し、その invocation override を保ちます。詳しくは[設定全体の解決順](settings.md)を参照してください。

resume では model / reasoning を保存値に固定せず、CLI / 環境変数の invocation override と最新の merged config から毎回解決します。保存時に `full` scheme を使っていた旧 sidecar も、config digest の違いだけでは拒否しません。比較できる場合は差を診断情報として扱い、現在の clone の設定で backend resume を試みます。

保存時と現在の conductor backend / MCP digest / profile / worker `acpCwd` が異なる場合も、保存値へ戻したり digest 不一致だけで拒否したりせず、現在の設定で復元を試みます。worker は現在の workspace cwd で `session/load` し、保存時 cwd が無い・読めない場合や保存時 clone にだけ残るローカル状態を引き継げない場合は具体的な warning を出します。conductor backend の `resume` が失敗した場合、session の起動を成功扱いしません。

resume・再保存では旧 scheme と digest をそのまま記録情報として保持し、自動で新しい scheme に読み替えません。scheme 省略 / `full` で digest がない旧 store は比較できない旨を warning で知らせ、欠如したまま保存します。旧 `resume-feasibility` store に `acpModelConfigDigest` がない場合も診断情報がない旨を warning で知らせますが、digest はバックフィルしません。`resume-feasibility` digest がない sidecar と未知の scheme は不正データとして拒否します。

hash には merge 後の値を使い、設定ファイルのパスや秘密値を sidecar に保存しません。旧 sidecar の平文 ACP env は読み込み時に digest へ置き換えて書き戻します。保存時と現在の設定差があっても、新しい session を開始する前に現在の backend で復元を試みます（[ADR 0048](adr/0048-session-resume-feasibility-config-digest.md)、[`conductor.reasoning` の分類](adr/0051-conductor-reasoning-resume-digest.md)、[Cursor runtime と worker metadata](adr/0054-cursor-acp-runtime-verification.md)）。

## テンプレート

リポジトリ直下の [`config.example.yaml`](../config.example.yaml) をコピーして使う。実運用の config は `.ensemble/` 配下のため **gitignore 対象**（方針 A）。チームで共有したい非秘密項目だけ example を更新する。

```bash
mkdir -p .ensemble
cp config.example.yaml .ensemble/config.yaml
# またはユーザ全体
mkdir -p ~/.ensemble
cp config.example.yaml ~/.ensemble/config.yaml
```

## スキーマ（Phase 1）

```yaml
profile:
  default: implementer-and-reviewer-v2 # ENSEMBLE_DEFAULT_PROFILE 相当

config:
  loadProjectConfig: true              # 選択された user config で制御。false で project config を無視

conductor:
  backend: pi                        # pi（既定） | cursor
  model: default                      # CONDUCTOR_MODEL_ID 相当
  # reasoning: high                  # 任意。選択した backend / model により対応値が異なる
  verbose: false                      # CONDUCTOR_VERBOSE / --verbose 相当
  pi:
    # 任意。省略時は ~/.ensemble/pi と <repoRoot>/.ensemble/pi
    agentDir: ~/.ensemble/pi
    projectDir: .ensemble/pi

acp:
  defaultPreset: codex                # ENSEMBLE_DEFAULT_ACP_CLI 相当
  pi:
    runtime: byo                      # byo（既定）| builtin
  env:                                # codex-acp 子プロセス spawn に渡す env（選択された user config → project deep merge）
    MODEL_PROVIDER: litellm           # Codex provider ID。接続設定は Codex config 側
  models:                             # 環境固有の model catalog
    opus:
      model: YOUR_OPUS_MODEL_ID
      reasoning: high                 # 任意。対応する ACP preset に渡す
    sonnet: YOUR_SONNET_MODEL_ID
    haiku: YOUR_HAIKU_MODEL_ID
    sonnet-lite:
      model: YOUR_SONNET_MODEL_ID
      reasoning: low
  tags:                               # profile の modelTag → models key
    high: opus
    default: sonnet
    low: haiku
    lite: sonnet-lite

session:
  worktree: isolated                  # --worktree 既定（isolated | in-repo）
  lazyWorkers: false                  # true: 初回 prompt_worker まで worker ACP attach を遅延
  maxTurns:
    tty: 0                            # 0 = 無制限
    nonTty: 5
  postLoop:
    wait: true                        # TTY 時 post-loop 待機（--no-wait で上書き）

github:
  auth:
    allowGhAuthTokenFallback: true
  monitor:
    enabled: true
    debounceMs: 60000
    pollIntervalMs: 120000
    activePollIntervalMs: 60000
    stopPollWaitMs: 5000

tui:
  layout: stream                      # TTY での既定（pane に戻す場合は明示）
  forceHyperlink: auto                # FORCE_HYPERLINK 相当（auto | on | off）
```

### キー一覧

| キー | 意味 | CLI 上書き | env 上書き |
|------|------|-----------|-----------|
| `config.loadProjectConfig` | project `.ensemble/config.yaml` を読み込むか（既定: `true`、選択された user config のみ有効） | — | — |
| `profile.default` | 既定 team profile（名前またはパス） | `--profile` | `ENSEMBLE_DEFAULT_PROFILE` |
| `conductor.model` | conductor モデル id | `ensemble issue --model` | `CONDUCTOR_MODEL_ID` |
| `conductor.reasoning` | conductor reasoning / thinking level | `ensemble issue --reasoning` | `CONDUCTOR_REASONING` |
| `conductor.verbose` | harness 詳細 telemetry の表示 | `--verbose` | `CONDUCTOR_VERBOSE` |
| `conductor.backend` | conductor LLM backend（`cursor` / `pi`） | — | — |
| `conductor.pi.agentDir` | Pi user resource root のパス上書き | `PI_CODING_AGENT_DIR`（config 未指定時） | — |
| `conductor.pi.projectDir` | Pi project resource root のパス上書き | — | — |
| `acp.defaultPreset` | worker ACP built-in preset | `--default-acp-cli` 等 | `ENSEMBLE_DEFAULT_ACP_CLI` |
| `acp.pi.runtime` | Pi worker の runtime（`byo` / `builtin`、既定 `byo`） | — | — |
| `acp.env` | codex-acp 等 spawn 時の env（string map） | — | — |
| `acp.models` | model key → model ID または `{ model, reasoning?, cursorFast? }` | — | — |
| `acp.tags` | model tag → `acp.models` key（全 worker 共通） | — | — |
| `session.worktree` | worker workspace モード | `--worktree` | — |
| `session.lazyWorkers` | 初回 `prompt_worker` まで worker ACP attach を遅延 | — | — |
| `session.maxTurns.tty` / `nonTty` | 自律ターン上限 | `--max-turns` / `--no-max-turns` | — |
| `session.postLoop.wait` | post-loop 待機（TTY） | `--no-wait` | — |
| `tui.layout` | TTY レイアウト（`pane` / `stream`） | — | `ENSEMBLE_TUI_LAYOUT` |
| `tui.forceHyperlink` | Issue リンク・Pi OAuth URL の OSC 8（`auto` / `on` / `off`） | — | `FORCE_HYPERLINK`（`1`/`0`） |
| `github.auth.allowGhAuthTokenFallback` | `gh auth token` フォールバック | — | — |
| `github.monitor.enabled` | Issue / PR 監視 | `--no-github-monitor` | — |
| `github.monitor.debounceMs` | 更新 debounce | `--github-monitor-debounce-ms` | — |
| `github.monitor.pollIntervalMs` 他 | poll 間隔（コード内既定のみ） | — | — |

`config.loadProjectConfig` は config の merge 対象を決めるメタ設定です。project YAML の値は、設定結果にも project config の読み込み判断にも使われません。`--config` 指定時は、その明示ファイルが選択された user config なので、このキーもそこから解決します。

### Conductor reasoning

`conductor.reasoning` は空でない文字列です。`ensemble issue` と直接 API では `--reasoning` / `RunConductorSessionOptions.reasoning` > `CONDUCTOR_REASONING` > merged config の順で解決します。operator-agent は専用 config の `profiles.<name>.conductor.reasoning` / `common.conductor.reasoning` と `ENSEMBLE_OPERATOR_AGENT_REASONING` を使い、`CONDUCTOR_REASONING` は参照しません。どちらも値は固定 enum にせず、選択した backend と model が受け付けるかを起動時に検証します。未指定なら reasoning を渡さず、backend の既定に任せます。設計判断は [ADR 0050](adr/0050-operator-agent-conductor-reasoning.md) と [ADR 0061](adr/0061-github-slug-session-persistence.md) を参照してください。

- **Pi**: 指定値を Pi 1.x `createAgentSession({ thinkingLevel })` に渡します。Pi の native level は `off` / `minimal` / `low` / `medium` / `high` / `xhigh` / `max` です。選択 model の対応 level を session 作成前に確認し、未知・未対応値はエラーにします。provider 固有のリクエスト値への変換は Pi model の `thinkingLevelMap` と Pi の provider adapter に委ねます。ensemble の互換性ガードにより、`google-generative-ai` / `google-vertex` の Gemini 4 model に reasoning を明示した場合も session 作成前にエラーにします。値を省略した場合、`settings.json` の `defaultThinkingLevel` は従来どおり headless conductor / operator-agent で読みません。
- **Cursor**: [Cursor SDK の model parameter catalog](https://cursor.com/docs/sdk/typescript#model-parameters) を照会し、選択 model の reasoning / thinking / effort parameter と値を特定して `ModelSelection.params` に渡します。parameter ID と値は model / account ごとに異なるため、catalog 上で一意に対応しない値や候補は agent の create / resume 前にエラーにします。値を省略したときは catalog を照会せず、SDK の既定に任せます。

終了サマリの `sessionModels.conductor.configuredReasoning` は優先順位解決後の指定値です。provider が実際に適用した値を読み戻した結果ではありません。型・表示の詳細は [session-metrics.md](session-metrics.md#231-モデル構成sessionmodels) を参照してください。

### Pi worker runtime

`claude` / `codex` / `pi` preset は core 同梱の adapter を使います。欠落時はエラーになり、PATH 上の同名コマンドには切り替わりません。別の adapter を使うには `--default-acp-command codex-acp` のように明示します。これは custom preset となり、built-in 固有のモデル注入や認証設定は適用されません。詳細は [ACP preset の解決](settings.md#パターン-c--acp-preset-解決)を参照してください。

Pi worker は `acp.pi.runtime` で実行環境を選びます。省略時と `byo` は従来の動作で、upstream `pi-acp@0.0.33`（core 同梱の adapter）と PATH 上の `pi` CLI を使い、Pi の `~/.pi` 設定・認証・session map・transcript を読み書きします。既存の SessionResumeStore に runtime marker がない Pi session も BYO として読み、BYO の既定値や保存済み fingerprint は変えません。

```yaml
acp:
  defaultPreset: pi
  pi:
    runtime: builtin
```

`builtin` は core に別名 dependency として同梱する upstream `pi-acp@0.0.35` を core 内の wrapper から起動し、core dependency に含まれる Pi CLI を adapter へ渡します。BYO adapter は引き続き `0.0.33` です。`0.0.35` も `0.0.34` と同じく `get_available_thinking_levels` RPC を `session/new` / `session/load` 時に要求しますが、既存の Pi CLI `0.80.6` はこの RPC を提供しません。BYO と builtin の版を分ける理由は [ADR 0069](adr/0069-pi-acp-version-split-for-byo-compatibility.md) に記録しています。Pi CLI の global install、PATH 設定、`~/.pi` の事前準備は不要です。この runtime は Node.js **22.19.0 以上**を要求します。builtin を選んだときだけ起動前に upstream adapter、Pi CLI、Node.js の版を検証します。

builtin の user settings と認証には、Pi conductor と同じ user resource root を使い、解決順は `conductor.pi.agentDir` > `PI_CODING_AGENT_DIR` > `~/.ensemble/pi/` です。同梱する `defaultThinkingLevel: medium` と `enableSkillCommands: true` は初回のみ `settings.json` へコピーし、既存の設定を上書きしません。認証済み provider がない場合、Pi ACP は `AUTH_REQUIRED` で attach を拒否します。Pi CLI を別途用意する必要はありませんが、provider の認証は必要です。Pi backend が選択されている場合、`ensemble auth login --provider <provider-id>` は同じ user root の `auth.json` に credential を保存します。Cursor backend が選択中なら `--provider` だけでは Pi 認証へ切り替わらず、Pi credential は設定されません。provider 環境変数も利用できます。`acp.env.PI_CODING_AGENT_DIR` ではなく `conductor.pi.agentDir`（または `PI_CODING_AGENT_DIR`）で user root を設定してください。認証手順は [Pi conductor セットアップ](pi-conductor-setup.md)を参照してください。

builtin Pi ACP adapter の `HOME` / `USERPROFILE` は Issue と worker ごとの `~/.ensemble/pi/worker/<repoKey>/issue-<issueNumber>/<workerKey>/` に設定します。upstream 固定の `$HOME/.pi/pi-acp/session-map.json` を複数 Issue 間で共有しないためです。Pi CLI とその shell command には wrapper が起動時の利用者 `HOME` / `USERPROFILE` を戻すので、`~/.gitconfig`、`~/.ssh/config`、SSH key、GitHub CLI の設定などを通常の user home から参照できます。`acp.env.HOME` または `acp.env.USERPROFILE` を指定すると、Pi CLI と shell command に渡す home 環境変数を変更できます。Pi の settings / auth root は別に `conductor.pi.agentDir` で指定します。shell command からその home 配下の設定・credential を利用できるため、worker に許可する操作と併せて管理してください。home の解決方法は子ツールごとに異なります。たとえば macOS の OpenSSH は `HOME` ではなく OS account の home を使うため、alternate home を使う場合は SSH の設定も確認してください。

worker の session map と transcript は `~/.ensemble/pi/worker/<repoKey>/issue-<issueNumber>/<workerKey>/` に保存します。`workerKey` は worker 名を安全に符号化した識別子です。これにより、同じ repository で同名 worker が別 Issue を同時に処理しても、upstream adapter の map 全体の read-modify-write が競合しません。transcript は `PI_CODING_AGENT_SESSION_DIR` に保存します。旧 builtin runtime が repo・worker 間で共有していた map は、Issue ごとの upstream map がまだない場合に wrapper がコピーし、旧 map と transcript は削除しません。`ensemble session workers messages` は Issue ごとの map を優先し、移行前の旧 map も読めます。既存 session の resume は移行した map から旧 transcript path を引き続き使います。BYO と builtin の間で既存 session を切り替えて resume することはできません。

POSIX では wrapper が専用 parent `~/.ensemble/pi/worker` と、起動した repository の worker storage tree にある既存 directory を `0700`、map・transcript file を `0600` に直します。新規 file は wrapper の `umask 077` を継承します。POSIX の保存先内に symlink または通常 file / directory 以外がある場合は、誤った場所を chmod しないよう builtin の起動を失敗させます。Windows では Node.js の mode 指定を ACL の代わりにせず、`icacls.exe` で専用 parent と repository storage tree の owner を現在の account SID に揃え、DACL をその account だけに制限します。Windows PowerShell の .NET ACL API で owner と ACE を読み戻して検証し、PowerShell / `icacls.exe` / ACL の設定・検証に失敗した場合は builtin adapter を起動しません。map / transcript が指定先内に通常の方法で作られる限り、既存と新規の directory / file にこの ACL が適用されます。対象は worker の map / transcript 保存先だけで、共有 Pi settings / auth root、BYO、同じ OS account の別 process、管理者 / SYSTEM / backup privilege、ACL を無視する storage、upstream が指定先外へ書く・ACL を明示的に広げる場合は対象外です。固定 upstream の更新時に保存先と permission の振る舞いを再確認してください（[ADR 0070](adr/0070-issue-scoped-builtin-pi-storage.md)、[ADR 0071](adr/0071-builtin-pi-storage-windows-acl.md)）。

upstream `pi-acp` の `session/list` は `PI_CODING_AGENT_SESSION_DIR` を参照せず、Pi user root の `settings.json.sessionDir`（未指定なら `agentDir/sessions`）を探索します（BYO `0.0.33` / builtin `0.0.35`）。そのため worker map が失われると、transcript が残っていても upstream の discovery fallback からは見つかりません。builtin の保存 session を `session/load` できない場合、resume は worker failure として終了し、新しい session の作成や resume prompt の送信は行いません。ResumeStore の旧 session ID は保持されます。reader も map なしでは transcript を推測せず `unavailable` を返します。map がない場合の自動復旧は行わない、という制約は [ADR 0068](adr/0068-builtin-pi-home-and-resume-safety.md) に記録しています。

### ACP model tag と model catalog

model ID・任意の reasoning と tag mapping は環境ごとの `.ensemble/config.yaml` に置きます。team profile は `workers[]` の各 worker インスタンスに `modelTag` だけを指定します。

```yaml
# config.yaml
acp:
  defaultPreset: codex
  models:
    opus:
      model: YOUR_OPUS_MODEL_ID
      reasoning: high
    sonnet: YOUR_SONNET_MODEL_ID
    haiku: YOUR_HAIKU_MODEL_ID
    lite:
      model: YOUR_SONNET_MODEL_ID
      reasoning: low
  tags:
    high: opus
    default: sonnet
    low: haiku
    lite: lite
    urgent: opus
```

```yaml
# profile.yaml
workers:
  - name: implementer
    kind: implementer
    modelTag: high
  - name: reviewer
    kind: reviewer
    modelTag: default
  - name: researcher
    kind: researcher
    modelTag: urgent
  - analyst # 文字列 shorthand も default tag
```

model catalog は従来どおり model ID の文字列で指定できます。構造化エントリには `model` と任意の `reasoning` を指定し、Cursor preset 用に任意の `cursorFast` も指定できます。`model` と `reasoning` は空でない文字列、`cursorFast` は boolean です。Codex の `reasoning` には `low`、`medium`、`high`、`xhigh`、`max`、`ultra` などがありますが、対応値は model と client に依存します（[Codex 設定リファレンス](https://developers.openai.com/codex/config-reference/)）。ensemble は値の一覧を固定せず Codex に渡します。設定として受け付けられても、利用する model がその値に対応するとは限りません。

`models` と `tags` は user config → project config の順に deep merge します。構造化エントリの `model`、`reasoning`、`cursorFast` も個別にマージします。例えば user 側の `opus: YOUR_OPUS_MODEL_ID` に対して project 側で `opus: { reasoning: high }` と書くと、model ID を引き継いで reasoning を追加できます。逆に project 側で文字列 shorthand を指定すると、user 側のエントリ全体を置き換え、user 側の属性も消します。`model`、`reasoning`、`cursorFast` のいずれかを指定した構造化エントリの最終結果に `model` がない場合や、指定した値の型が合わない場合はエラーです。Cursor の別設定経路がない `cursorFast` は Cursor 用 field として parse しますが、明示すると spawn 前に fail fast します。model-only の `model` は公式 CLI の `--model` option にそのまま渡します。

profile の `workers[].modelTag` と config の `acp.tags` key は任意の文字列で、空文字や空白だけの文字列もそのまま照合します。YAML では `modelTag: ""` のように書き、空 tag key は `"": blank`、空白 tag key は `"  ": spaced` のように引用符で囲みます。`high` / `default` / `low` / `lite` は組み込み team 向けに意味を定めた推奨 tier で、詳しくは [user team の modelTag](user-teams.md#worker-modeltag-と-tier-の慣習) を参照してください。`lite` は default 相当の model と短めの reasoning などで throughput を優先する tier で、Cursor ACP の fast mode（`cursorFast`）とは別概念です。`default` 以外の選択 tag（空文字・空白のみを含む）の mapping がなければ harness warning を出して `acp.tags.default` を試し、それもなければ model を注入せず ACP preset の既定を使います。`modelTag` を省略した worker が内部で選ぶ `default` は warning なしで preset の既定を使います。`modelTag: default` を明示した worker で mapping がなければ warning を出して preset の既定を使います。mapping があるのに参照先 key が `models` にない場合は起動前にエラーにします。tag mapping と resume digest の判断は [ADR 0062](adr/0062-worker-acp-model-tags.md)、[ADR 0063](adr/0063-explicit-default-model-tag-warning.md)、[ADR 0064](adr/0064-worker-model-tags-allow-empty-strings.md) に記録しています。

worker 名・kind ごとの model 表は設けません。profile の `modelTag` は組み込み語を含む任意の文字列を受け付けます。preset・spawn env・model ID は引き続き config 側が正本です。

model と reasoning の渡し方は preset ごとに異なります。Cursor model-only の ensemble 契約は、公式 CLI option に model ID をそのまま渡すことです。ACP の応答やサマリ値は上流内部の runtime attestation ではありませんが、その attestation を毎回要求しません。

| preset | model の渡し方 | reasoning / model variant |
|--------|----------------|--------------------------|
| `cursor` | 公式 CLI の `agent --model <model-id> acp` に model ID をそのまま渡す | 別 field の `reasoning` / `cursorFast` は spawn 前に fail fast。省略時は capability / setter を送らず Cursor CLI の既定に委ねる |
| `claude` | session metadata の Claude settings に加え、`model` config option を session 作成・load 後に設定 | `reasoning` は ACP config option `effort` |
| `codex` | `CODEX_CONFIG` JSON の `model` | `reasoning` は同じ JSON の `model_reasoning_effort` |
| `pi` | ACP config option `model`。値は `provider/model-id` 形式 | `reasoning` は ACP config option `thought_level` |
| `custom` | 汎用の注入契約なし。tag が model ID に解決された場合は spawn 前にエラー | model 注入と同様に非対応 |

Cursor の公式 CLI reference は `--model <model>` を使用モデルの指定として掲載し、ACP docs は `agent acp` を advanced integration 向けの起動方法として案内しています（[CLI parameters](https://prod.cursor.com/docs/cli/reference/parameters)、[ACP docs](https://prod.cursor.com/docs/cli/acp)）。そのため model-only の ensemble 経路は、解決した ID をこの option にそのまま渡すところまでを契約とします。内部 runtime の model を各 session で独立に証明することは要件にしません。

一方、[forum #159748](https://forum.cursor.com/t/cursor-cli-agent-model-ignores-reasoning-thinking-level-suffix/159748) は、CLI の reasoning suffix が落ちたという別個の報告です。Cursor 担当者は後日、最新版で再確認するよう依頼しましたが、現在の作業では対象 model を使った認証付き再現をしていません。model ID に suffix がある場合も値はそのまま `--model` に渡しますが、suffix の個別挙動を確認済みとはしません。この再現は [Issue #638](https://github.com/otolab/agents-ensemble/issues/638) で引き渡し後に確認します。

[forum #174835](https://forum.cursor.com/t/cursor-cli-acp-reports-grok-4-6-fast-despite-explicitly-selecting-the-listed-non-fast-model/174835) では、picker capability がない ACP session で non-Fast ID が Fast に置き換わり、実 request も Fast variant になった例を Cursor 担当者が説明しています。picker と setter 後の ACP `currentValue` は session option の報告であり、runtime model の attestation ではありません。[別の報告](https://forum.cursor.com/t/document-and-stabilize-non-fast-model-selection-for-acp-stdio-sessions/165622) にも ACP 応答と内部 session slug の食い違いがあります。これらの報告を踏まえ、現在は別 field の `reasoning` / `cursorFast` を明示した場合は spawn 前に失敗させ、`cursorFast` 省略時は capability / setter を送らず CLI default に委ねます。実際の default variant は未確認です（[ADR 0054](adr/0054-cursor-acp-runtime-verification.md)、[ADR 0055](adr/0055-cursor-model-only-cli-contract.md)）。

`claude` と `pi` の model ID は各 ACP session config option が広告する値を指定します。Pi ACP の upstream adapter は `provider/model-id` を広告し、model と thinking level を session 単位で設定します（[ADR 0067](adr/0067-pi-acp-upstream-package-wrapper.md)）。この `model` / `thought_level` は worker の Pi ACP session 用で、Pi conductor の `conductor.backend: pi` が読む `settings.json` / `models.json` や `ModelRuntime` の設定とは別経路です。Pi conductor の設定・認証は [専用ガイド](pi-conductor-setup.md)を参照してください。ACP の thinking level は model が対応する範囲に限られます。Pi 0.85.1 の issue #9768 では、`set_thinking_level` が成功を返しても `get_state` が古い値を返し続ける事例が報告されています。投稿では非同期の設定更新を待たずに RPC 応答する実装が原因候補に挙がり、maintainer は model が level を clamp する可能性にも触れています。この issue は completed で閉じられていますが、harness は成功応答だけを信用せず、設定後の値が一致しない場合は最初の prompt より前に attach を失敗させます（[Pi issue #9768](https://github.com/earendil-works/pi/issues/9768)）。Claude は model metadata だけでは SDK 側の設定で値が戻る可能性があるため、session 作成・load 後にも `model` と必要な `effort` を設定します（[`claude-agent-acp` 0.70.0](https://github.com/agentclientprotocol/claude-agent-acp/blob/v0.70.0/src/acp-agent.ts)）。

ACP v1 の session config option は Agent が session setup 時に現在値と候補を返し、`session/set_config_option` の response で設定後の option を返します（[ACP v1 仕様](https://agentclientprotocol.com/protocol/v1/session-config-options)）。`claude` / `pi` では harness が候補に指定値があることと、設定後に Agent が報告した `currentValue` が要求値と一致することを確かめてから最初の prompt を許可します。これは ACP adapter が報告する session configuration の確認であり、backend が実際に使う model / effort の attestation ではありません。Cursor の model-only 経路はこの setter を使わず、公式 CLI `--model` option に値を渡す契約です。option 不在、候補不一致、setter error、報告値不一致は対応する ACP config-option 経路の attach error とします。resume 時、builtin Pi の `session/load` 失敗は新しい session に fallback せず attach を失敗させ、保存済み ID を保ちます（[ADR 0068](adr/0068-builtin-pi-home-and-resume-safety.md)）。builtin Pi 以外で通常の `session/load` が失敗した場合は新しい session に切り替えます。一方、ACP config-option の検証・適用エラーは attach を失敗させ、新しい session への切り替えでは隠しません。

tag mapping がない場合は従来どおり各 preset の native default に委ねるため、段階的に tag を割り当てられます。`codex` の model mapping では、既存の `CODEX_CONFIG` があれば JSON object 文字列である必要があります。`acp.env` の値は親プロセスの同名環境変数より優先されます。Codex ACP では `MODEL_PROVIDER` が `CODEX_CONFIG.model_provider` より優先され、どちらもなければ Codex の設定に委ねられます。harness は `model` と、指定された場合だけ `model_reasoning_effort` を上書きし、他の JSON キーを保持します。catalog に `reasoning` がない場合、既存の `CODEX_CONFIG` にある値も保持し、そこにもなければ Codex の既定に委ねます。`MODEL_PROVIDER` の値そのものは保存せず、resume fingerprint には hash のみを保持します。

`reasoning` は空でない文字列として扱い、preset 間で共通の enum は設けません。`claude` / `pi` では advertised option と報告された値を確認し、Codex では `CODEX_CONFIG` に渡します。Cursor の公式 model-only 経路は `model` を `--model` に渡すことです。別 field の `reasoning` / `cursorFast` に対応する安定した公式注入経路は確認できないため、明示時は spawn 前に失敗します。model ID に含まれる suffix は値の一部としてそのまま渡しますが、その suffix が上流で適用されたと主張しません。`custom` は command 任意のため汎用経路を仮定せず、tag が model catalog に解決された場合は [model catalog の設定](#acp-model-tag-と-model-catalog) と [ADR 0052](adr/0052-acp-model-injection-by-preset.md) を示して spawn 前に失敗します。`acp.env` は引き続き custom command に渡せます。

### ACP spawn env（`acp.env`）

`acp.env` は codex-acp 等の子プロセス spawn 時に渡す環境変数の正本です。team profile に preset / env の直書きはありません（`acp` / `workers[].acp` を YAML に書くと load 時エラー）。worker ごとのモデル tier は profile `workers[].modelTag` で選びますが、model ID と mapping は `acp.models` / `acp.tags` に置きます。

#### 設定レイヤーの用語（混同防止）

| レイヤー | 正本 | 扱うもの |
|----------|------|----------|
| **team profile** | `profile.yaml` / `--profile` | conductor と workers（kind・workspace・`modelTag`・Skill 素材など）。modelTag は worker の tier 選択のみ |
| **ensemble config** | `.ensemble/config.yaml` | ACP（preset・`env`・model ID catalog・tag mapping）、session・GitHub・conductor model 等 |
| **Codex profile** | `~/.codex/config.toml` + `codex --profile <name>` | Codex CLI の世界の profile（ensemble team profile とは無関係） |

#### env のマージ順（後勝ち）

spawn 解決時、子プロセスへ渡す env は次の順でマージされます。

1. **builtin preset 既定** — 例: codex の `INITIAL_AGENT_MODE: agent`
2. **config `acp.env`** — 選択された user config（`--config` 指定時は標準 user config を置換）→ project の deep merge 済み

`acp.env` は他キーと同様に deep merge し、project 層が user 層の値を上書きします。`--config` 指定時は明示ファイルが user 層となり、標準 user config は読み込みません。CLI / 環境変数による `acp.env` の個別キー上書きは Phase 1 では未提供。spawn 時は `process.env` を基底に `spawn.env` が上書きする（[ADR 0028](adr/0028-authentication-delegation-and-ensemble-auth.md)）。

#### LiteLLM（OpenAI 互換ゲートウェイ）向け config 例

Codex worker の接続先は Codex の provider 設定で定義し、`acp.env.MODEL_PROVIDER` で使う provider ID を選びます。ensemble はこの環境変数を `codex-acp` に渡すだけで、TOML ファイルを選んだり読み込んだりはしません。

`@agentclientprotocol/codex-acp` は `packages/core/package.json` で **2.12.0** に pin されています。`CODEX_CONFIG` は Codex session config に merge する **JSON オブジェクト文字列**として `JSON.parse` されます。TOML のパスを設定すると JSON parse に失敗します。`MODEL_PROVIDER` は新しい session に渡す **provider ID** で、設定ファイルの選択には使われません。`INITIAL_AGENT_MODE` は初期の承認・sandbox mode を選びます。有効な mode ID は `read-only`、`workspace-write`、`agent`、`agent-full-access`、`permission-profile:<profile-id>` です。

`INITIAL_AGENT_MODE` が未設定または空文字列の場合、Codex が現在利用可能な mode として返した permission profile のうち、config の active profile に一致するものがあればそれを選びます。一致する profile がなければ既定の `agent` を選びます。一方、未知の**非空**値が指定された場合は active profile を調べず、`agent` に戻ります。したがって、空文字列は未設定と同じ扱いですが、未知の値とは fallback の経路が異なります。ensemble は値を解釈せず、`acp.env` から子プロセスへ渡します。

2.12.0 では、ACP session から渡された MCP server と Codex config の `mcp_servers` を併せて扱います。同名 server が Codex config にすでに定義されている場合は、既定で ACP 側の重複を除き、Codex config の定義を使います。そのため `CODEX_CONFIG` に置いた server / tool 単位の設定（`output_token_limit` など）を保持できます。`DISABLE_MCP_CONFIG_FILTERING=true` はこの重複除去を無効にします。この変更は MCP server 設定の解決方法に関するもので、Codex 本体の応答上限や切り詰め動作が変わることを意味しません。

以下は **2.3.0 時点の実測記録**です。2.3.0 の既定 `agent` と明示的な `workspace-write` は、どちらも `approvalPolicy=on-request` かつ `workspaceWrite` sandbox ですが、approval reviewer が異なります。`agent` は `auto_review` で Codex 側が審査し、明示 `workspace-write` は `user` で client 側に判断を求めます。そのため `on-request` だけから、すべての確認が ACP `session/request_permission` として harness に届くとは限りません。`user` reviewer は client に review を委ねますが、ACP permission request が実際に発生するかは個別の操作・審査によります。当時の `workspace-write` 試行では ACP request が届き、`auto_review` の `agent` 試行では届きませんでした。これは approval の振り分けの違いであり、両 mode の sandbox policy はどちらも `workspaceWrite` です。詳細は [codex-acp 2.3.0 の mode 定義](https://github.com/agentclientprotocol/codex-acp/blob/v2.3.0/src/AgentMode.ts)を参照してください。

当時の 2.3.0 / ACP v1 harness smoke では、既定 `agent` は ACP permission request なしで tool update 4 件を返し、marker file の作成まで観測しました。session log は `on-request` / `auto_review` / `workspace-write` でした。この request の不在は `auto_review` reviewer の経路と矛盾せず、それ自体は承認処理の bypass を示しません。ただし、個別の auto-review 判断は記録されていません。また probe path が Codex の writable roots 外だったことも確認できていないため、marker 作成が sandbox 境界の内外どちらで起きたかも、この結果だけでは結論づけられません。一方、`INITIAL_AGENT_MODE=workspace-write` を明示した試行では ACP permission request 1 件を受け、harness が `reject_once` を返すと prompt は `cancelled` となり、marker は作成されませんでした。これはその試行で ACP 経由の拒否を確認した結果であり、他 mode・path の sandbox 挙動まで証明するものではありません。

Codex の model ID はトップレベルの `model`、provider は `model_provider` で指定し、provider IDに対応する `[model_providers.<id>]` から接続先・API形式・認証方法を読みます。worker では Codex が通常の設定レイヤー（主に `~/.codex/config.toml`）を読み、必要であれば `CODEX_CONFIG` の JSON が session config に加わります。`MODEL_PROVIDER=litellm` だけでは、Codex は別ファイル `litellm.config.toml` を探さず、model IDも選びません。

`CODEX_CONFIG` の JSON には `model`、`model_provider`、`model_providers` などCodex session configのキーを含められます。ただし `MODEL_PROVIDER` を設定した場合は、codex-acp が新しいsessionの provider IDとしてその値を別途渡し、JSON内の `model_provider` より優先します。model IDとprovider IDに対応する定義は、それぞれCodexの通常configかJSON設定に必要です。model IDはLiteLLM側で提供されるものを指定してください。

以下の例では秘密値を記載せず、環境変数名を使います。実際の `LITELLM_API_KEY` はシェル等で設定してください。

#### A. provider 設定を正本 config にまとめる（推奨）

provider 定義を `~/.codex/config.toml` に置き、ensemble config では provider ID だけを指定します。Codex CLI と worker が同じ provider 定義を参照し、worker の接続先は `MODEL_PROVIDER` で切り替えられます。

```toml
# ~/.codex/config.toml
model = "YOUR_LITELLM_MODEL_ID"
model_provider = "litellm"

[model_providers.litellm]
name = "LiteLLM"
base_url = "https://litellm.example/v1"
wire_api = "responses"
env_key = "LITELLM_API_KEY"
```

```yaml
# ~/.ensemble/config.yaml または <repo>/.ensemble/config.yaml
acp:
  defaultPreset: codex
  env:
    MODEL_PROVIDER: litellm
```

`model` にはLiteLLM側で提供する実際のmodel IDを指定します。Codex CLI とworkerの両方がこのmodel設定を使います。`MODEL_PROVIDER` はworker sessionで使うproviderだけを選び、model IDは変更しません。別providerへ切り替える場合は、そのproviderでも同じmodel IDが利用できることを確認してください。Codex CLIで別の既定providerを使う場合は、`model_provider` をそのprovider IDにします。認証値は設定ファイルに書かず、Codexが参照する環境変数で渡してください。

#### B. Codex CLI のprofile overlayを使う

Codex CLI の `codex --profile litellm` は、まず `~/.codex/config.toml` を読み、その上に `~/.codex/litellm.config.toml` を重ねます。profile ファイルには `[profiles.litellm]` ではなく通常のトップレベル設定を書きます。Codex 0.134.0 以降、`config.toml` 内の `[profiles.litellm]` と `profile = "litellm"` による指定は使われません。

```toml
# ~/.codex/litellm.config.toml — Codex CLI 用 overlay
model = "YOUR_LITELLM_MODEL_ID"
model_provider = "litellm"

[model_providers.litellm]
name = "LiteLLM"
base_url = "https://litellm.example/v1"
wire_api = "responses"
env_key = "LITELLM_API_KEY"
```

このprofile overlayは **Codex CLI 用**です。ensemble worker は `codex-acp` から Codex `app-server` を起動する経路であり、`codex --profile` を指定できません。worker にはAのように provider 定義を `~/.codex/config.toml` に置くか、Cのように `CODEX_CONFIG` でsession設定を渡してください。Codex の `config.toml` に別TOMLを読み込む公式include機能はありません。CLI profileとworkerで別ファイルを正本にする場合、worker側の設定にも同じprovider定義が必要です。手動で同期するか、設定生成で両方を作成してください。

#### C. worker 用 JSON 設定を別ファイルで管理する

小規模な設定や検証では、worker 専用の JSON ファイルを用意し、その**内容**を `CODEX_CONFIG` に渡せます。`CODEX_CONFIG` 自体にはファイルパスではなくJSON文字列を設定します。例えば、次のファイルを作成します。

```json
{
  "model": "YOUR_LITELLM_MODEL_ID",
  "model_providers": {
    "litellm": {
      "name": "LiteLLM",
      "base_url": "https://litellm.example/v1",
      "wire_api": "responses",
      "env_key": "LITELLM_API_KEY"
    }
  }
}
```

そのファイルの内容を環境変数に読み込み、`acp.env` では `CODEX_CONFIG` を上書きしないで起動します。

```sh
export CODEX_CONFIG="$(jq -c . "$HOME/.codex/ensemble-worker.json")"
ensemble issue 123
```

```yaml
# ~/.ensemble/config.yaml または <repo>/.ensemble/config.yaml
acp:
  defaultPreset: codex
  env:
    MODEL_PROVIDER: litellm
```

`jq -c` は JSON を1行に整形して環境変数へ渡します。`acp.env` に `CODEX_CONFIG` を設定した場合は、親プロセスから継承した値より `acp.env` の値が優先されます。設定を別ファイルで保ちたい場合は、ファイル内容を起動前に環境変数へ変換してください。CではCodex CLIのprovider設定は変わらず、JSONはworker sessionにのみ適用されます。

#### Codex CLI と ensemble worker の違い

| 起動方法 | 設定の選択・読み込み | LiteLLM の指定 |
|----------|--------------------|----------------|
| `codex --profile litellm` | Codex CLI が `~/.codex/config.toml` に `~/.codex/litellm.config.toml` をoverlay | profileファイルに `model`、`model_provider`、provider 定義を記述 |
| ensemble の Codex worker | `codex-acp` → Codex `app-server`。`--profile` は渡せない。Codex の通常 config とsession設定を利用 | `MODEL_PROVIDER` でprovider IDを選択し、`model` は通常config（A）または `CODEX_CONFIG` JSON（C）で指定 |

`CODEX_CONFIG_PROFILE` によるprofile名指定は Codex 側で未実装です（[openai/codex#38104](https://github.com/openai/codex/issues/38104)）。したがって worker のprofile選択手段としては使えません。

#### resume と `acp.env` 変更

config digest と ACP spawn fingerprint の差は、`resume-feasibility` / 旧 `full` scheme のどちらでも resume を事前拒否する条件にしません。保存時の preset / runtime / command / args / model / reasoning / env は診断情報として保持し、resume は現在 clone の config と profile で `session/load` を試みます。保存 session を実際に復元できない場合は、backend / runtime の復旧方針に従って失敗を通知します。古い prompt や tool call は再送しません。詳細は [ADR 0048](adr/0048-session-resume-feasibility-config-digest.md)、[ADR 0054](adr/0054-cursor-acp-runtime-verification.md)、[ADR 0067](adr/0067-pi-acp-upstream-package-wrapper.md) を参照してください。

### Pi resource root

`conductor.backend: pi` のとき、Pi 1.x の標準ファイル名・ディレクトリを次の 2 層から解決します。プロジェクト層がユーザ層を上書きします。

| 層 | 既定パス |
|----|----------|
| ユーザ | `~/.ensemble/pi/` |
| プロジェクト | `<repoRoot>/.ensemble/pi/` |

`conductor.pi.agentDir` / `conductor.pi.projectDir` は resource root のパスだけを上書きします。相対パスは `<repoRoot>` 基準、`~` はユーザ home 基準です。各 root の Pi 標準 resource を次のように解決します。

- `settings.json` / `auth.json`: user → project の deep merge。credential は provider 単位で project entry を優先します。
- `models.json`: Pi 標準の `providers` / `models` / built-in `modelOverrides` / request headers を model 解決へ反映します。Google Gemini 3+ を model ID に世代が現れない名前で提供する場合は、`google-generative-ai` / `google-vertex` model の `compat.supportsStrictMode: true` で strict tool schema 対応を明示できます。
- `extensions/`: ExtensionAPI の tool を読み込み、fixed harness tools と local extension tools を conductor の custom tools として追加します。同名の harness tool は上書きしません。MCP は下記の Pi 公式 extension が担当します。
- `skills/`: Pi 標準の skill discovery（`DefaultResourceLoader`）で索引します。system prompt には name / description / location のカタログを載せ、本文は `read` または `/skill:<name>` で読みます。`settings.json` の `skills` 配列で `.claude/skills` 等の追加パスを指定できます。profile の `conductor.piSkills`（省略時は有効）で無効化できます。
- `prompts/`: Markdown template を読み込み、`/name args` の user prompt を Pi 標準の引数置換で展開します。
- `themes/`: Pi 標準 JSON として読み込み、project 同名を優先します。conductor は headless `AgentSession` のため TUI renderer がなく、theme の色・表示設定はモデル入出力には適用しません。

`ensemble models show [model]` は Pi の組み込み model 情報と、同じ user → project resource から解決した `models.json` / `modelOverrides` を使って `contextWindow` などを表示します。認証情報や headers の解決、remote catalog access は行いません。表示値は Pi の組み込み情報またはローカル定義に由来し、provider の実上限を検証した値ではありません。Cursor SDK など Pi 以外の backend では `contextWindow` を取得できないことを明示します。CLI の設定優先順、provider の選択、custom model の既定値は [Pi conductor セットアップと認証](pi-conductor-setup.md)を参照してください。

Pi の初回セットアップ、provider 認証、認証優先順、TTY / stderr の login、project OAuth の制約、`ensemble models list`、missing key / 401 の復旧は [Pi conductor セットアップと認証](pi-conductor-setup.md)を正本とします。この config reference では、headless conductor が `settings.json.apiKeys[provider]` の非 command 値を runtime override として使い、scalar `settings.json.apiKey` は別の fallback 経路で扱うこと、`models.json` の provider `apiKey` と `!command` も Pi resource として解決することを定義します。`!command` は conductor process の shell と OS user / 環境で実行され、worker permission 処理や harness の sandbox を通りません。repository の project resource も実行可能な設定として扱い、信頼できる設定でのみ使用してください。`gcloud auth print-identity-token` 等を連続実行しないためのキャッシュ付きヘルパーは harness では提供せず、[pi-conductor-setup.md の `!command` とトークン取得](pi-conductor-setup.md#command-とトークン取得の連続実行litellm--gcloud-等) と Node 実装の [scripts/pi/cached-auth.mjs](../scripts/pi/cached-auth.mjs) を参照してください。`@agents-ensemble/cli` の配布物には `scripts/pi/cached-auth.mjs` と、これへ委譲する非推奨の `.sh` wrapper が含まれます。既存 `~/.ensemble/pi/cached-auth.sh` コピーからの移行と p50 測定手順も Pi セットアップガイドに記載しています。Pi の MCP HTTP OAuth は provider OAuth とは別に、公式 MCP extension が管理します。

#### `settings.json` の headless 対応範囲

conductor は Pi 1.x の `createAgentSession` / `DefaultResourceLoader` を headless で使います。TUI と package manager は起動しないため、`settings.json` は Pi 標準のファイル名と resource path の意味を保ちますが、headless conductor が実際に参照するキーだけを契約とします。

この契約のコード正本は [`pi-headless-settings.ts`](../packages/core/src/conductor/pi-headless-settings.ts) の `PI_HEADLESS_SETTING_DEFINITIONS` です。各キーには、conductor 内の `model-selection` / `auth-fallback` / `resource-path`、Pi SDK の `settings-manager-override` のいずれかの適用チャネル、または `ignored` が定義されています。表はコード正本を利用者向けに説明したものです。表にないキーも `ignored` と同じ扱いです。

実際に効くキーは次のとおりです。

| キー | 適用チャネル | headless conductor での意味 |
|------|--------------|----------------------------|
| `defaultProvider` / `defaultModel` | `model-selection` | 明示的な `provider/model` がない場合のモデル選択。`model` / `modelId` は conductor の互換 alias として同じ選択に使います。 |
| `apiKey` | `auth-fallback` | 通常の scalar 値は Pi `ModelRuntime` が key を返さなかった場合の最終 fallback です。`!command` は settings 候補として `apiKeys[provider]` より先に選ばれ、request 用の provider 設定として Pi runtime に登録されます。ただし、非 command の `apiKeys[provider]` がある場合は、その runtime override が先に解決されます。 |
| `apiKeys` | `auth-fallback` | `apiKeys[provider]` の非 command 値は `ModelRuntime.setRuntimeApiKey` で runtime override として登録し、user `auth.json` より先に使います。`!command` は runtime override ではなく、scalar `apiKey` がない場合に settings 候補として選ばれ、request 用の provider 設定として登録されます。 |
| `extensions` / `skills` / `prompts` / `themes` | `resource-path` | 各 resource root を基準に追加で読む path。通常の `extensions/` 等の discovery と併用します。 |
| `compaction.*` | `settings-manager-override` | Pi の `AgentSession` が行う manual / automatic compaction。`enabled`、`reserveTokens`、`keepRecentTokens`、`modelOverrides` だけを user → project の deep merge 結果から `SettingsManager` へ渡します。 |
| `branchSummary.*` | `settings-manager-override` | Pi の branch summary。`reserveTokens` / `skipPrompt` だけを `compaction.*` と同じ merge 結果から `SettingsManager` へ渡します。 |

#### Pi 標準の `<cwd>/.pi/settings.json` との関係

Pi SDK の file-backed `SettingsManager` は通常、`agentDir/settings.json` と `<cwd>/.pi/settings.json` を自動的に読み込みます。しかし headless conductor はこの経路を使わず、**`SettingsManager.inMemory()` にコード正本で allowlist した settings-manager チャネルだけを渡します**。したがって、`<cwd>/.pi/settings.json`（および Pi 標準の `agentDir/settings.json`）に書いた値が headless conductor へ漏れることはありません。

headless conductor の設定正本は常に `~/.ensemble/pi/settings.json` と `<repoRoot>/.ensemble/pi/settings.json` です。Pi CLI 用の `<cwd>/.pi/settings.json` とのコピー・symlink・自動マイグレーション・書き換えは行いません。`.pi` の設定を使う別の Pi CLI と、`ensemble issue` の Pi backend は独立しています。

#### create / reload / resume の適用ポリシー

- **create**: `loadPiResources` が `.ensemble/pi` の user → project を deep merge し、モデル選択・認証・resource path は各チャネルで使い、`compaction.*` / `branchSummary.*` は allowlist 後に in-memory `SettingsManager` へ適用します。
- **reload**: Pi `AgentSession.reload()` の後に、create 時に解決した同じ settings-manager スナップショットを再適用します。実行中の `.ensemble/pi/settings.json` の変更を hot reload する契約ではないため、設定変更を反映するには `resume` または新しい create が必要です。`AgentSession.reload()` または snapshot の再適用が失敗した場合は、snapshot の復元を試みた後、session を close / dispose して unusable とします。失敗が 1 つだけで close / dispose が成功した場合はその元のエラーを reject し、reload と snapshot 復元の両方、または close / dispose の cleanup error も発生した場合は `AggregateError` を reject します。`AggregateError.errors` には発生した元の reload / snapshot エラーと cleanup error が含まれます。失敗した session は send で再利用せず、同じ transcript を続ける場合も `resume`、新しい作業なら create で再作成してください。
- **resume**: 新しい Pi session を作るため `.ensemble/pi` を再読込し、create と同じチャネル適用を行ってから既存 transcript を開きます。resume でも `<cwd>/.pi/settings.json` は読みません。

Pi の `settings.md` にあるが headless conductor / operator-agent が適用しないキーは、Pi SDK の SettingsManager へ渡さず、拒否せず警告なしで無視します。`defaultThinkingLevel` を無視する契約は Pi settings に対するものです。Issue conductor の reasoning は ensemble config の `conductor.reasoning`、operator-agent の reasoning は専用 config の profile / `common.conductor.reasoning` から指定します。

| 無視するキー（または prefix） | 適用されない挙動 |
|------------------------------|------------------|
| `defaultThinkingLevel` / `modelThinkingLevels` / `thinkingBudgets` / `enabledModels` | thinking level、budget、model cycling の設定 |
| `hideThinkingBlock` / `showCacheMissNotices` / `notices.*` / `cacheWarming` / `steeringMode` / `followUpMode` | transcript 表示、cache、対話キューの設定 |
| `defaultTools` / `codemode.*` | `defaultTools` は headless conductor では無視します。built-in coding tools は profile の `conductor.builtinTools`（省略・未指定は有効、`false` のみ無効）で制御し、`config.yaml` には同キーを設けません。 |
| `packages` | Pi package の install・解決。package が提供する resource は自動導入しません。 |
| `enableSkillCommands` | skill command の登録 toggle。読み込んだ skill の `/skill:<name>` 展開可否はこのキーで変更できません。 |
| `sessionDir` | Pi の settings にある session 保存先は conductor では変更できません。Issue transcript は `~/.ensemble/sessions/github.com/<owner>/<repo>/pi/`、workspace transcript は `~/.ensemble/workspaces/<slug>/pi/` に保存し、再開・履歴・export はそれぞれの保存先を参照します。未移行の path-hash / project-local transcript は [一括 inventory / copy tool](session-logging.md#legacy-data-の一括-inventory-copy) で明示的に移行します。 |
| `theme` / `quietStartup` / `tuiMode` / `fullscreen*` / `terminal.*` / `images.*` / `markdown.*` | headless conductor の TUI・terminal 表示 |
| `transport` / `httpProxy` / `httpIdleTimeoutMs` / `websocketConnectTimeoutMs` / `retry.*` / `shellPath` / `shellCommandPrefix` / `npmCommand` | Pi coding-agent の network、shell、package runtime |
| `collapseChangelog` / `enableInstallTelemetry` / `enableAnalytics` / `warnings.*` | coding-agent の update、telemetry、UI warning |

表にない未対応キーも同じく無視します。`models.json`、`auth.json`、`extensions/`、`skills/`、`prompts/`、`themes/` の対応範囲は上記 resource の説明どおりです。

conductor の system prompt の基底は modular-prompt のコンパイル結果です。`.ensemble/pi/SYSTEM.md` / `APPEND_SYSTEM.md`（または resource root の同名ファイル）は conductor には読み込みません。

`.ensemble/` は既存のリポジトリ共通 gitignore 方針で無視されるため、Pi のローカル設定・認証・extension はコミットしません。

### GitHub 認証トークンの解決順

`resolveGitHubAuthToken({ config })`（`@agents-ensemble/core`）:

1. 環境変数 `GITHUB_TOKEN`
2. 環境変数 `GH_TOKEN`
3. `config.github.auth.allowGhAuthTokenFallback: true` のときのみ `gh auth token`

`allowGhAuthTokenFallback: false` のときは **`gh auth token` を呼ばない**。CI 等では `GH_TOKEN` / `GITHUB_TOKEN` を明示設定すること。

## 移行

### env / コード default → config

| 従来（env / コード default） | config キー | 備考 |
|------------------------------|-------------|------|
| `ENSEMBLE_DEFAULT_PROFILE` | `profile.default` | env は CI 上書き用として維持 |
| `CONDUCTOR_MODEL_ID` | `conductor.model` | 同上 |
| `ENSEMBLE_DEFAULT_ACP_CLI` | `acp.defaultPreset` | 同上 |
| CLI `--worktree` 既定 `isolated` | `session.worktree` | |
| eager worker attach | `session.lazyWorkers: false` | 未指定も eager（後方互換） |
| TTY 無制限 / 非 TTY 5 | `session.maxTurns.tty` / `nonTty` | |
| TTY post-loop 待機 ON | `session.postLoop.wait` | |
| monitor 各種定数 | `github.monitor.*` | |
| `ENSEMBLE_TUI_LAYOUT` | `tui.layout` | env は invocation 上書き用として維持 |
| `FORCE_HYPERLINK` | `tui.forceHyperlink` | `1`/`0` ↔ `on`/`off`。未設定 ↔ `auto` |

**config 未作成時**は従来どおり env とコード default のみが効く（後方互換）。

`session.lazyWorkers` は既定 `false` です。`true` にすると profile の全 worker を session に登録して TUI / `list_workers` に `sleeping` と表示し、初回の通常 `prompt_worker` で対象 worker だけを attach / init します。init prompt 完了後に最初の instruction を別ラウンドで送り、その後はセッション終了まで常駐します。resume は SessionResumeStore に保存した設定を使い、ACP session のある worker は再 attach、まだ使っていない worker は sleeping のままにします。lazy 設定のない旧 SessionResumeStore は eager として扱います。

### team profile `acp` の削除

team profile の `acp` / `workers[].acp` は **削除済み**。YAML に残すと profile load 時にエラーになる。

1. `acp.defaultPreset` → `.ensemble/config.yaml` の `acp.defaultPreset`
2. `acp.env` / `workers[].acp.env` → `acp.env`（user / project の適切な層へ）
3. profile 側の `acp` ブロックを削除

worker 単位の ACP preset 切り替えは対象外です。tier 配分は profile の `workers[].modelTag`、環境固有の model ID は config の `acp.models` / `acp.tags` で設定します。

## Conductor MCP 設定（mcp.json）

conductor が使う server を ensemble config の `conductor.mcp.servers` に名前で指定する。標準 user config またはその代替の `--config` を読み、project config が有効ならその設定を後から適用する。project の配列は user の配列を追加せず置き換える。`servers: []` または両層で未指定なら MCP なしで起動する。team profile は選択に関与しない。

```yaml
conductor:
  mcp:
    servers: [example]
```

選択した名前の定義を次の 2 層から読み込み、`mcpServers` のサーバー名単位でマージする。

| 層 | パス | 優先度 |
|----|------|--------|
| プロジェクト | `<repoRoot>/.agents/mcp.json` | 高（同名を上書き） |
| ユーザ | `~/.ensemble/mcp.json` | 低（既定） |

プロジェクト設定が同名サーバーを定義した場合は、ユーザ設定の定義全体を置き換える。選択名が定義されていない場合は server 名と両方の定義ファイルの場所を示して起動を止める。定義を書くだけでは server は起動しない。従来の全 server 自動選択は廃止されたため、使い続ける server は明示的に選択する。

ファイル形式は Cursor SDK の `mcp.json` 形式（`mcpServers` オブジェクト）を使う。

```json
{
  "mcpServers": {
    "example": {
      "type": "stdio",
      "command": "npx",
      "args": ["-y", "some-mcp-server"],
      "env": {
        "API_KEY": "${env:API_KEY}"
      }
    }
  }
}
```

選択後の設定だけを conductor の両 backend に同じ map として渡す。Cursor SDK では `Agent.create` / `Agent.resume` の inline MCP として、Pi では Pi 1.x の `DefaultResourceLoader` に `createMcpExtension({ loadConfig })` を extension factory として登録し、`createAgentSession` の起動時に注入する。Pi 側で `.pi/mcp.json` へ同期・コピー・symlink は行わず、resume 時は現在 clone で解決した map を使う。SessionResumeStore にはこの map の canonical SHA-256 digest を診断情報として保存するが、digest の差だけで resume を拒否しない。digest に秘密値そのものは保存しない。MCP 接続の管理、tool discovery、OAuth、resource tools は Pi 公式 extension に委ね、core は MCP client/transport を実装しない。

`command` / `args` / `env` / `cwd` / `url` / `headers` / `auth` は harness 境界で Cursor 形式の placeholder を解決してから Pi 公式 extension に渡す。`${env:VAR}` は現在の process environment の値、`${workspaceFolder}` / `${workspaceFolderBasename}` は conductor の cwd へ変換し、値が見つからない placeholder は literal のまま渡さず明確なエラーにする。Pi 標準の `$VAR` / `${VAR}` は公式 resolver に委ねる。Pi は `stdio` と Streamable HTTP (`http`) をサポートするが、shared `mcp.json` の `sse` 定義は Pi 1.x ではサポートしないため、Pi conductor の起動時に明確なエラーにする。HTTP の `auth` (`CLIENT_ID` / `CLIENT_SECRET` / `scopes`) は Pi の MCP OAuth 設定へ渡され、認可フローと credential 保存は公式 extension が管理する。`.cursor/mcp.json` や `.pi/mcp.json` へのコピー・symlink、`settings.json` の書き換えは行わず、ACP worker にはこの設定を渡さない。MCP server tool は公式名 `mcp__<server>__<tool>`（長すぎる・衝突する場合は Pi の hash suffix）で公開される。resources がある場合は公式の `list_mcp_resources`、`list_mcp_resource_templates`、`read_mcp_resource` が提供される。`codemode` / `tool_search` の exposure は公式 extension の設定に従う。

Pi backend は `@earendil-works/pi-coding-agent@1.6.1` の公式 MCP extension を使う。MCP 未設定時は extension に空の解決結果を渡し、conductor は harness tools と local extension tools だけで起動する。

JSON が不正、または `mcpServers` / サーバー定義の形式が不正な場合は、そのファイルを `[mcp]` 警告とともにスキップする。もう一方の層が有効ならそちらは引き続き読み込み、両方をスキップした場合は MCP なしで起動する。MCP のホットリロードは行いません。実行中の session の設定を変更した場合、再開時は現在 clone の MCP config で復元を試み、backend が復元できない場合はその失敗を通知します。

## 秘密情報を config に書かない

**token 本体を config に平文で保存しない。** 認証は環境変数、`gh auth login`、Cursor の `ensemble auth login`、または Pi の provider 単位 `ensemble auth login` / `ModelRuntime` を使う。MCP HTTP OAuth の credential は Pi 公式 extension の管理領域に保存する。

## スキーマ外キー

YAML に未知のキーがあっても **無視する**（警告なし）。将来のスキーマ拡張用に残してよい。既知キーで型が合わない値も原則 **該当キーのみ**無視し、下位層またはデフォルトにフォールバックする。ただし `conductor.reasoning` は空文字・空白のみ・非文字列をエラーにし、構造化した `acp.models` エントリの `model` / `reasoning` も、明示された値が無効ならエラーにする。

## 関連

- [pi-conductor-setup.md](pi-conductor-setup.md) — Pi conductor の初回セットアップ・認証・復旧（利用者向け正本）
- [settings.md](settings.md) — 全設定層の一覧・解決パターン（本書は config.yaml 詳細）
- [ADR 0028](adr/0028-authentication-delegation-and-ensemble-auth.md) — worker の認証移譲とCodex runtime設定
- [Codex profiles / custom model providers](https://developers.openai.com/codex/config-advanced#profiles) — Codex CLI profile overlay、`model`、`model_provider` の現行仕様
- [codex-acp 2.12.0 runtime options](https://github.com/agentclientprotocol/codex-acp/blob/v2.12.0/README.md#runtime-options) — `INITIAL_AGENT_MODE` / `CODEX_CONFIG` / `MODEL_PROVIDER` などの説明
- [codex-acp 2.12.0 起動処理](https://github.com/agentclientprotocol/codex-acp/blob/v2.12.0/src/index.ts) — 環境変数の parse と Codex app-server 設定への受け渡し
- [codex-acp 2.12.0 mode 定義](https://github.com/agentclientprotocol/codex-acp/blob/v2.12.0/src/AgentMode.ts) — permission profile を含む mode と reviewer の定義
- [codex-acp 2.12.0 MCP config 解決](https://github.com/agentclientprotocol/codex-acp/blob/v2.12.0/src/CodexAcpClient.ts) — Codex config と ACP session の MCP server 定義の扱い
- [ADR 0020](https://github.com/otolab/agents-ensemble/blob/main/docs/adr/0020-ensemble-config-setting-resolution.md) — 解決順の設計判断
- [ADR 0018](https://github.com/otolab/agents-ensemble/blob/main/docs/adr/0018-team-profile-four-layer-resolution.md) — `.ensemble/` 配下の規約（team-profile）
- [#223](https://github.com/otolab/agents-ensemble/issues/223) — config 基盤
- [#228](https://github.com/otolab/agents-ensemble/issues/228) — Phase 1 拡張
