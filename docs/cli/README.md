# agents-ensemble CLI

> **正本:** npm の `@agents-ensemble/cli` と GitHub の CLI 利用者向け入口。インストール・最小クイックスタート・doc 索引を掲載します。

`@agents-ensemble/cli` は、GitHub Issue を起点に conductor が worker を起動・制御する CLI です。conductor は Cursor SDK（既定）または Pi（opt-in）を選べます。

## インストール

Node.js 22 以上を用意し、npm または pnpm でインストールします。

```bash
npm install -g @agents-ensemble/cli
# または
pnpm add -g @agents-ensemble/cli

ensemble --help
```

## Conductor backend の選択

既定の backend は `cursor`（Cursor SDK）です。Pi を使う場合は、リポジトリの `.ensemble/config.yaml` またはユーザ設定の `~/.ensemble/config.yaml` で `conductor.backend` を `pi` にします。

```yaml
conductor:
  backend: pi
```

Pi backend の初回セットアップ、resource root、provider 認証、`ensemble auth` / `ensemble models list`、missing key / 401 からの復旧は [Pi conductor セットアップと認証](https://github.com/otolab/agents-ensemble/blob/main/docs/pi-conductor-setup.md) が正本です。Pi の model catalog を扱う `models remote` / `diff` / `add` と旧 `sync` からの移行も同ガイドを参照してください。Pi の user root は `~/.ensemble/pi/`、project root は `<repoRoot>/.ensemble/pi/` が既定で、`conductor.pi.agentDir` / `conductor.pi.projectDir` で上書きできます。

Pi の認証 CLI は backend に分岐します。Cursor は Cursor SDK のログイン、Pi は provider 単位のログインです。TTY の動作、OAuth の stderr 出力、project OAuth の制約、認証優先順、復旧手順は [Pi conductor セットアップと認証](https://github.com/otolab/agents-ensemble/blob/main/docs/pi-conductor-setup.md) を参照してください。

Pi は headless の `createAgentSession` を使い、Pi CLI の `<cwd>/.pi/` 設定とは独立しています。resource discovery、`settings.json` の headless 対応範囲、`models.json`、MCP の制約は [config.md](https://github.com/otolab/agents-ensemble/blob/main/docs/config.md) と [ADR 0025](https://github.com/otolab/agents-ensemble/blob/main/docs/adr/0025-conductor-agent-backend-sdk-and-pi.md) を参照してください。

headless conductor の設定キーと create / reload / resume の適用範囲は [config.md の headless 対応範囲](https://github.com/otolab/agents-ensemble/blob/main/docs/config.md#settingsjson-の-headless-対応範囲) を参照してください。

Pi の MCP transport、OAuth、resource tools、resume 時の制約は [ADR 0025](https://github.com/otolab/agents-ensemble/blob/main/docs/adr/0025-conductor-agent-backend-sdk-and-pi.md) にまとめています。

backend はセッション開始時に選択され、resume の途中では切り替えられません。system prompt の渡し方、認証、resume の差分は [ADR 0025](../adr/0025-conductor-agent-backend-sdk-and-pi.md) にまとまっています。

backend を選んだ後の主経路は共通です。リポジトリのディレクトリで、対象 Issue を同じ `ensemble issue <url>` コマンドに渡します。

## permission 停滞警告の閾値

`ensemble issue` の `--permission-deadlock-stall-ms <n>` で、worker の permission が停滞したときに警告・conductor 通知を出すまでの時間を上書きできます。既定値は **`300_000ms`（300 秒）**です。設定値の解決順と API 名は [設定値リファレンス](https://github.com/otolab/agents-ensemble/blob/main/docs/settings.md) を参照してください。poll 間隔と worker UI の挙動はこのオプションでは変更しません。

## dispatch hold reminder の間隔

dispatch hold が続く間、harness は既定 **30 分ごと**に、held buffer の件数と解除を促す reminder を operator 向け telemetry として表示します。`ensemble issue` の `--dispatch-hold-reminder-ms <n>` で間隔を上書きできます。通知のみで、自動解除はしません。詳細と API 名は [設定値リファレンス](https://github.com/otolab/agents-ensemble/blob/main/docs/settings.md) を参照してください。

## 最小クイックスタート

初回だけ、worker・選択した conductor backend・GitHub API の認証を準備します。

既定の `cursor` preset は、npm パッケージに含まれない Cursor Agent CLI の `agent` コマンドを使用します。先に [Cursor Agent CLI の公式インストール手順](https://cursor.com/docs/cli) に従ってインストールしてください。

| 対象 | 準備 |
|------|------|
| worker（既定の Cursor ACP） | `agent login` |
| conductor（Cursor SDK、既定） | `ensemble auth login` |
| conductor（Pi、API key） | `ensemble auth login --provider <id>`（TTY の secret prompt） |
| conductor（Pi、OAuth） | `ensemble auth login --provider <id>`（TTY。URL / device code は stderr） |
| GitHub API（gh CLI を使う場合） | `gh auth login` |

```bash
# worker（既定の Cursor ACP）
agent login

# conductor（Cursor SDK を使う場合）
ensemble auth login

# conductor（Pi を使う場合。provider 省略時は settings.json から解決）
ensemble auth login --provider <provider-id>
ensemble auth status
ensemble models list

# GitHub API（gh CLI を使う場合）
gh auth login
```

GitHub API トークンを直接渡す場合は、`gh auth login` の代わりに `GITHUB_TOKEN` または `GH_TOKEN` を設定してください。

リポジトリを clone したディレクトリで、対象 Issue を指定して起動します。

```bash
cd /path/to/your/repository
ensemble issue https://github.com/OWNER/REPOSITORY/issues/123
```

Issue セッションで conductor に reasoning / thinking level を明示する場合は `--reasoning <level>` を指定します。選択した backend と model が値に対応しないと起動前にエラーになります。config・環境変数を含む優先順位と backend ごとの対応値は [設定値リファレンス](../settings.md) と [ensemble 共通設定](../config.md#conductor-reasoning) を参照してください。

```bash
ensemble issue https://github.com/OWNER/REPOSITORY/issues/123 --reasoning high
```

起動時だけ user config を差し替える場合は `--config <path>` を指定します。指定時は `~/.ensemble/config.yaml` を読み込まず、指定ファイルを user 層として扱います。project config は引き続き別層で適用され、同じ項目は project 側が優先されます。`~` は home に展開されます。

```bash
ensemble issue https://github.com/OWNER/REPOSITORY/issues/123 --config ~/.ensemble/litellm.config.yaml
```

人間との TTY 対話を operator-agent に委ねる場合は `ensemble operator-agent [--repo-root <path>] [--config <path>]` を使います。Issue セッションとは別の agent session で起動し、backend・model・reasoning・profile・認証は conductor の設定を共有します。reasoning は `conductor.reasoning` または `CONDUCTOR_REASONING` で指定できます。Pi backend ではユーザー／プロジェクト側の Pi extension を operator session に読み込みません。

operator-agent は既定で前回の operator 会話を再開します。初回起動では新しい session を作り、backend 固有の会話履歴は backend の保存先に、再開に使う backend・repoRoot・agentId は `~/.ensemble/operator-agent/<repoKey>/session.json` に保存します。TTY の EOF、Ctrl+C（SIGINT）、SIGTERM など通常の終了では agent を閉じて再開可能な状態を保ちます。`/exit` または `exit` は連続性を明示的に切り、次回起動を新規 session にします。既存の会話を残したまま新しい会話を始める場合は `ensemble operator-agent --new` を使います。強制終了や電源断では終了時の flush は保証されません。

## 保存済み session の閲覧

`ensemble session` は、保存済み conductor / worker session をローカルから読み取る CLI です。agent との会話、harness や ACP の起動、session への再接続は行いません。`operator-agent` が LLM と対話し、複数 session の監視や conductor への操作を担うのに対し、`ensemble session` は保存データを表示するだけです。

```bash
# 現在の repository の保存 session を一覧する
ensemble session list

# Issue URL で絞り込む
ensemble session list --issue-url https://github.com/OWNER/REPOSITORY/issues/123

# sidecar と関連 YAML の場所・要約を見る
ensemble session show <conductorAgentId>

# Pi / Cursor の conductor 会話履歴を見る
ensemble session messages <conductorAgentId>

# Pi ACP worker の会話履歴を見る
ensemble session workers messages <conductorAgentId> --worker implementer

# 保存データ・終了サマリ・captured stderr を send 番号で照合する
ensemble session timeline <conductorAgentId> \
  --summary session-summary.json \
  --harness-log harness.log
```

`--repo-root <path>` は各 subcommand で指定できます（既定値は現在のディレクトリ）。各 subcommand の `--json` は JSON を出力します。テキスト表示は `NO_COLOR` が空でない値に設定されていると色を使いません。

`list` は SessionResumeStore の要約を更新時刻の新しい順に返します。`show` は sidecar の許可したメタデータ、sidecar と関連 YAML のパス、Open Questions の件数、session-state の報告時刻・履歴件数を表示します。worker ごとに保存 preset と transcript reader の対応状況も表示します。ここで示すのは preset に対する reader の有無で、transcript file が現在読み取れるかまでは確認しません。

`messages` は保存 session の `conductorAgentId` を指定し、operator-agent の `list_conductor_messages` と同じ core provider-history API を使うデバッグ用コマンドです。既定では新しい履歴から20件、最大100件を表示します。`--limit <n>`、`--order asc|desc`、`--cursor <providerId>` でページを指定できます。返すのは user inbound と conductor の最終応答で、tool output や thinking は含みません。本文は保存値のまま出力し、テキスト表示も `--json` もサニタイズしません。API key・token・password などを会話に入力していた場合、その値も出力されます。`messages` は raw debug 経路を保ち、sanitizer の CLI option は設けていません。アプリから core API を使う場合は、返却前に `inbound` / `text` へ利用側の sanitizer を渡せます。適用境界、エラー時の動作、秘密値保護の限界は [provider history list の API 契約](../live-open-question-control-api.md#operator-agent-の-provider-history-list)を参照してください。

`workers messages` は保存済み ACP session を `--worker <name>` で指定します。現在オフラインで読めるのは Pi ACP（`pi`）と Codex ACP（`codex`）です。Pi は CLI process の home にある `~/.pi/pi-acp/session-map.json` から保存 session ID に対応する JSONL を解決し、active branch の user / assistant 本文を出します。

Codex ACP の `sessionId` は Codex thread ID です。Codex CLI は `$CODEX_HOME`（未設定なら `~/.codex`）の `sessions/YYYY/MM/DD/rollout-<timestamp>-<thread-id>[_<rollout-id>].jsonl` に rollout を保存し、archive 済みの rollout は `archived_sessions/` に置きます。相対 `CODEX_HOME` は Codex ACP process と同じく、SessionResumeStore に保存された worker の `acpCwd` を基準に解決します。reader はファイル名から候補を探し、先頭の `session_meta.payload.id` と `cwd` を SessionResumeStore の session ID / cwd に照合します。同一 basename の `.jsonl` と `.jsonl.zst` がある場合は `.jsonl` を優先します。本文には `response_item` の user / assistant message にある `input_text` / `output_text` だけを出し、tool、reasoning、event などは含めません。revert 等で同じ thread ID の rollout が複数見つかった場合は、履歴を誤選択しないよう `unavailable` にします。`.jsonl.zst` の圧縮 rollout は Node.js 22.15.0 で experimental として追加された `node:zlib.createZstdDecompress()` が使える場合に読めます。ACP process の起動、`session/load`、Codex の state DB 参照は行いません。

未対応 preset（`cursor`、`claude`、`custom` など）または preset が保存されていない旧 SessionResumeStore は `unsupported` と理由を表示し、終了コード 2 を返します。Pi / Codex の保存 map・rollout の欠落、session ID / cwd の不一致、破損、候補の曖昧さは `unavailable` と理由を返し、終了コード 1 で終了します。JSON では `status` と `reason` を確認できます。`session show` が示す `supported` は preset に対応する reader があることを表し、保存ファイルが現在読めることまでは確認しません。

reader は閲覧 CLI の現在の環境から `CODEX_HOME` を読み、相対値は保存済み worker `acpCwd` を基準に解決します。未設定時の `~/.codex` は閲覧 CLI の home を使います。worker 起動時だけ別の `HOME` / `CODEX_HOME` を指定していた場合、ResumeStore には spawn env の digest しか残らず、元の値や保存先は復元できません。そのため、閲覧 CLI の環境からその Codex home を特定できないと、rollout が存在していても `unavailable` になることがあります。

`timeline` は SessionResumeStore、conductor provider history、および任意の SessionSummary JSON / 保存済み harness stderr log を読みます。SessionSummary は `ensemble issue --summary-format json` の終了出力をファイルへ保存したものを `--summary <path>` で指定します。`--harness-log <path>` には、`[harness] conductor.send n=... status=...` と `[harness] conductor.transport.reconnect status=...` を含む stderr log を指定できます。これらのファイルは harness が自動保存するものではありません。データ源の未指定・読取不能・不正な JSON / schema・session 不一致は JSON / text に source 状態と理由を表示し、対象行がない log は認識件数 0 として示します。

Pi の provider history には `sendCount` がありますが、番号は harness process ごとに 0 から始まるため、resume をまたぐと再利用されます。誤った対応付けを避けるため、対象 session と一致する SessionSummary が読めた場合だけ、summary の `startedAt` より後、`startedAt + durationMs` より前に完了した Pi history を send 番号で照合します。開始・終了時刻と同じミリ秒の履歴は隣接 run と区別できないため照合せず、別枠に表示します。時間窓は生成元 SessionLogger の契約（開始が `Date.now()`、`durationMs` が終了時の `Date.now() - startedAt`）と照合します。相関に使うのは、`startedAt` と導出した終了時刻が `Date.now()` で表せる整数 Unix epoch ms で、`durationMs` が非負の安全な整数としてミリ秒精度を保てる場合だけです。契約や精度に合わない値は理由付きで `unavailable` とし、send 番号では照合しません。Cursor history には同じ番号がないので、時間と provider ID を別々に表示します。provider history は最大100件で、さらに古い履歴は表示されません。

この時間相関は、同じ session の process が重ならず、実行中にシステム時計が大きく変わらない前提です。SessionSummary と provider history には run / process ID や単調時計の時刻がないため、CLI は process の重複や時計の変更を検出できません。負の duration や表現できない時刻は相関を止めますが、前向きの時計変更で生じた範囲内の時間窓は判別できないことがあります。重複実行や時計変更の可能性がある調査では、時間相関を同一 run の証明として扱わないでください。

`--harness-log` には対象 run 1 回分の stderr を指定してください。log に run ID や時刻はないため、指定したログが summary と同じ process のものか CLI は検証できません。reconnect 行は直前に記録された send 行とのファイル内の順序を示すだけで、共通 event ID による対応付けや因果関係を表すものではありません。

Timeline の provider history は成功した user inbound / final response の組を返します。sendCount に対応する組が見つからなくても、raw provider transcript に未対応 entry がないことや、その原因が error / reconnect であることまでは断定できません。通常の保存先には全 SessionLogEvent の履歴がないため、captured log を指定していない場合、reconnect の実行状況は `not-provided` / `not-persisted` として示されます。

`timeline` は provider history と SessionSummary の `lastError` を出力する場合があります。`messages` / `workers messages` と同じく秘密値の redaction はしないため、ローカルの信頼できる端末で使い、結果を共有する前にサニタイズしてください。

`messages` はローカルの信頼できる端末でのデバッグに使ってください。stdout の pipe / redirect 先も生データを受け取ります。結果を Issue / PR、ログ、集計・蓄積先へ転記・保存する前に、利用側でサニタイズしてください。機密値を会話へ入力しない既存の運用方針も引き続き有効ですが、過去の入力を出力時に保護する保証ではありません。

`list` / `show` は保存済みデータの構造化ビューです。許可した sidecar メタデータと YAML の件数・時刻だけを表示し、質問・statusLine・profile 本文や worker session ID は出しません。旧形式に残る ACP 環境変数の平文値も SessionResumeStore の読取 API が除外します。この保護は `messages` と `workers messages` の会話本文には適用されません。

TTY の表示は `ensemble issue` と同じチャネル規約に沿います。`user>` / `operator>` は対話、`[harness]` は watch・dispatch・hold の状態と障害、`[observation]` は起動・終了・再接続などの運用通知です。`user>` は控えめに、`operator>` はシアンで表示し、operator の本文は次の行から表示します。監視報告 hold は理由と保留件数を `[harness]` の同じ形式で、状態が変わったときに更新します。`NO_COLOR` が設定されている場合は色を使いません。チャネルの詳細は [セッションロギング](../session-logging.md) を参照してください。

`~/.ensemble/sessions/<repoKey>/` の保存済み SessionResumeStore から得られる情報はスナップショットとして読み取り専用です。複数 session の watch は稼働中 harness の `session.observe` を使い、接続不能または未対応時には保存済み Open Questions YAML / session-state YAML / SessionResumeStore を poll して観測元を示します。`list_live_open_questions`、`answer_live_open_question`、`send_operator_message`、`get_last_conductor_message` は稼働中 session の直接 UDS control であり、停止・接続不能時にエラーとなり snapshot へ fallback しません。`get_last_conductor_message` は最後の応答だけを返します。`list_conductor_messages` は provider session history を直接読み、稼働中・停止後とも user inbound と final response の直近100件を上限に返します。Pi は active branch の entry ID と send 完了時刻を使い、Cursor は SDK run order / run ID / 作成時刻を使います。provider store を読めない場合は error になります。発言を継続受信する場合は `register_conductor_message_listen` / `unregister_conductor_message_listen` を使います。listen は稼働中 UDS の新着通知で、停止後 replay はしません。送った指示の後は `get_last_conductor_message` で最後の conductor 成功応答を確認でき、まだ成功応答がなければ `message: null` です。`send_operator_message` は `next`（既定）・`idle`・`interrupt` を指定できます。成功応答はキュー受理を示し、処理完了の確認ではありません。詳細は [稼働中 harness control API reference](../live-open-question-control-api.md)、セキュリティとログの扱いは [session logging](../session-logging.md#4-sessionresumestore-と-open-question-yaml) を参照してください。

初回の作業指示は、Issue 参照の後ろに CLI 引数として渡せます。複数の引数はスペース 1 つで結合され、前後の空白は除かれます。

```bash
ensemble issue https://github.com/OWNER/REPOSITORY/issues/123 受け入れ条件を確認して実装してください
ensemble issue https://github.com/OWNER/REPOSITORY/issues/123 "まずテストから始めてください"
```

これは TTY / 非 TTY の両方で、セッション開始後に 1 回だけ `operator.message` として conductor へ送られます。CLI メッセージと `ENSEMBLE_OPERATOR_MESSAGE` は併用できず、両方が空でない場合は起動エラーになります。`--continue` / `--resume` では CLI メッセージは注入されず、stderr に警告が出ます。詳細は [オペレータ入力](https://github.com/otolab/agents-ensemble/blob/main/docs/operator-input.md) と [設定値リファレンス](https://github.com/otolab/agents-ensemble/blob/main/docs/settings.md) を参照してください。

TTY で worktree とセッション状態を残してプロセスを閉じるには `/close` を入力します。正常に閉じると exit code 0 で終了し、再開するときは同じ Issue に `--continue` を付けます。同じ Issue に複数の保存 session がある場合、`--continue` は `close` / `abort` を優先し、`exit` は候補から除外します。選択規則の詳細は [SessionResumeStore の記録](../session-logging.md#4-sessionresumestore-と-open-question-yaml) を参照してください。`/exit` は isolated worktree の cleanup を試みて終了します（cleanup に失敗しても warning のみで exit code は 0、[#448](https://github.com/otolab/agents-ensemble/issues/448)）。Ctrl+C / SIGINT は `interrupted` として中断し、worktree cleanup を行いません。詳しくは [オペレータ入力](https://github.com/otolab/agents-ensemble/blob/main/docs/operator-input.md) を参照してください。

## 利用者向け doc

設定・TUI・認証の詳細は README に重複させず、次の正本を参照してください。

| 文書 | 内容 |
|------|------|
| [Pi conductor セットアップと認証](https://github.com/otolab/agents-ensemble/blob/main/docs/pi-conductor-setup.md) | Pi backend の resource root、provider 認証、`auth/models` CLI、障害復旧 |
| [設定値リファレンス](https://github.com/otolab/agents-ensemble/blob/main/docs/settings.md) | CLI / 環境変数 / config / profile / TUI と user-wide instructions |
| [ensemble 共通設定](https://github.com/otolab/agents-ensemble/blob/main/docs/config.md) | `.ensemble/config.yaml` の書き方・スキーマ・MCP 設定 |
| [オペレータ入力](https://github.com/otolab/agents-ensemble/blob/main/docs/operator-input.md) | TUI レイアウトと入力の利用者向け挙動 |
| [TUI ショートカット](https://github.com/otolab/agents-ensemble/blob/main/docs/cli-text-input-keybindings.md) | 入力ショートカットの対応状況と実装方針 |
| [ユーザ定義 team profile](https://github.com/otolab/agents-ensemble/blob/main/docs/user-teams.md) | `~/.ensemble/teams/` の profile 配置と解決順 |
| [conductor 認証再接続](https://github.com/otolab/agents-ensemble/blob/main/docs/conductor-auth-reconnect.md) | send 経路の in-process 再接続設計 |
| [Session usage と終了サマリ](https://github.com/otolab/agents-ensemble/blob/main/docs/session-metrics.md) | 終了時のモデル構成・開始時刻・経過時間と、TTY / JSON の token・cache・cost・compaction 表示および取得範囲 |

GitHub 上の全ドキュメントは [docs/README.md](https://github.com/otolab/agents-ensemble/blob/main/docs/README.md) から参照できます。
