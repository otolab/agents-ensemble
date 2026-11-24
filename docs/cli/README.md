# agents-ensemble CLI

> **正本:** npm の `@agents-ensemble/cli` と GitHub の CLI 利用者向け入口。インストール・最小クイックスタート・doc 索引を掲載します。

`@agents-ensemble/cli` は、GitHub Issue を起点に conductor が worker を起動・制御する CLI です。conductor は Pi（既定）または Cursor SDK を使います。worker は ACP preset に従って、それぞれの CLI / runtime と認証を使います。

GitHub を正本にしない作業には **`ensemble run <brief>`** を使います。brief はプロンプト用ファイルのパス、`--conductor-cwd` で slug をアンカーする cwd、状態は `~/.ensemble/workspaces/<slug-key>/` に保存します。`ensemble run list` で workspace 一覧、`--continue` で同一 slug の最新 run を再開します。詳細は [ADR 0085](../adr/0085-ensemble-run-workspaces-and-notes.md)。

調査と資料整理には同梱の team profile を `ensemble run brief.md --profile workspace-research` で指定できます。conductor が調整と Notes への記録を担い、explore と librarian が作業します。同名の profile がある場合、project、user、bundled の順に優先されます。`ensemble profiles list` では対応する入口の宣言と未指定・不正を区別できます。宣言は選択の目安であり、起動を制限しません。

`ensemble run brief.md --name investigation` は指定名を cwd の `.ensemble/workspace.json` に記録します。以後は同じ cwd から `ensemble run --continue` で再開できます。すでに別の slug が記録された cwd では別名を指定できません。名前の変更用 CLI は [#826](https://github.com/otolab/agents-ensemble/issues/826) で扱います。

worker は既定で conductor と同じ cwd を共有し、isolated worktree は作りません。profile の `workers[].workspace` を指定した worker はそのディレクトリを使います。GitHub Issue の取得や monitor は使いません。

conductor は `create_note` で summary 必須のノートを作り、`push_memo` でメモを追加できます。`list_notes` は summary と最新メモの冒頭を一覧し、`read_note` は既定で最新メモを返します。履歴は `includeHistory` と `historyOffset` / `historyLimit`、archive 済みメモは `includeArchived` で読めます。`archive_note` / `archive_memo` で非表示にした内容も読取可能です。Notes は workspace ごとに共有され、再開後も残ります。

`ensemble notes` は operator や run worker から同じ workspace Notes を操作します。例えば、operator は slug を明示し、worker は harness が渡す環境変数を利用できます。

```bash
# create の出力から得た ID を NOTE_ID に設定する
ensemble notes create --slug investigation --summary '調査の記録' --json
printf '%s\n' '確認した内容' | ensemble notes push --slug investigation --note "$NOTE_ID"
# ensemble run の worker 内（slug、repo root、conductor cwd は harness が注入）
printf '%s\n' 'worker の調査結果' | ensemble notes push --note "$NOTE_ID"
ensemble notes list --include-archived
ensemble notes show "$NOTE_ID" --history --offset 0 --limit 20
ensemble notes show "$NOTE_ID" --history --include-archived
ensemble notes archive "$NOTE_ID"
ensemble notes archive-memo --note "$NOTE_ID" --memo "$MEMO_ID" --archived false
```

各コマンドは `--repo-root`、`--slug`、`--conductor-cwd`、`--json` を受け付けます。slug は明示指定、`ENSEMBLE_WORKSPACE_SLUG`、conductor cwd の `.ensemble/workspace.json` の順に解決します。暗黙解決では既存 anchor だけを読み、新しい anchor は作りません。anchor がない場合は終了コード 2 です。Issue session 向けの Notes はなく、Issue worker には workspace 環境変数を注入しません。明示 slug での手動利用はセッション外でも可能です。repo root は明示指定、注入された `ENSEMBLE_WORKSPACE_REPO_ROOT`、git root の順に解決します。conductor cwd は明示指定、注入された `ENSEMBLE_WORKSPACE_CONDUCTOR_CWD`、現在の cwd の順です。

本文は前後の空白を除いて非空、UTF-8 で最大 512 KiB です。終了コードは成功 0、実行エラー 1、引数やコンテキストのエラー 2 です。`--json` 指定時、stdout には JSON のみを出力します。store は同じ note の更新をファイルロックで直列化し、一時ファイルから rename して保存します。ロックに参加しない外部の直接編集や、ファイルシステムのロック・rename の信頼性は保証しません。更新途中のプロセス終了では、完了前の更新は失われる場合があります。電源断やストレージ障害後の保存も保証されません。同じ slug を使う人は誰でも読み書きできます。

`ensemble run` の共通プロンプトには Issue / PR を正本とする既定は含まれません。ただし、既定の team profile は Issue / PR を前提とする materials を含むため、run では上記の `workspace-research` など、run に適した materials を持つ profile を指定してください。

## インストール

Node.js 22.19.0 以上を用意し、npm または pnpm でインストールします。Pi 依存の要件に合わせて最低バージョンを引き上げたため、22.13〜22.18 を使用している場合は Node.js を更新してください。

```bash
npm install -g @agents-ensemble/cli
# または
pnpm add -g @agents-ensemble/cli

ensemble --help
```

## Conductor backend の選択

既定の backend は Pi です。clone 後、TTY で `ensemble setup` を実行すると conductor の backend、Pi の既定 model、認証をまとめて設定できます。Cursor SDK を使う場合は setup で Cursor を選ぶか、config / profile で `conductor.backend: cursor` を指定します。

```yaml
conductor:
  backend: cursor
```

Pi backend の初回セットアップ、resource root、provider 認証、`ensemble auth` / `ensemble models list` / `ensemble models show`、missing key / 401 からの復旧は [Pi conductor セットアップと認証](https://github.com/otolab/agents-ensemble/blob/main/docs/pi-conductor-setup.md) が正本です。Pi の model catalog を扱う `models remote` / `diff` / `add` と旧 `sync` からの移行も同ガイドを参照してください。Pi の user root は `conductor.pi.agentDir`、`PI_CODING_AGENT_DIR`、`~/.ensemble/pi/` の順、project root は `conductor.pi.projectDir`、`<repoRoot>/.ensemble/pi/` の順で解決します。

clone したら、推奨初回導線として TTY で `ensemble setup` を実行します。Pi（OpenAI）または Cursor を選び、Pi では OAuth / API key も選べます。Pi を選んだ場合、`conductor.model: default` は user Pi settings に保存した provider / model を使います。設定と認証は user 層に保存し、既存 project config・project Pi resource・profile の値は変更しません。user の保存先が project `.ensemble` / Pi resource と重なる場合や、project の symlink から path として辿れる保存先と重なる場合は書き込みを中止します。project/profile が backend を指定している場合は user 設定より優先されます。setup を使わず Pi settings に model がなく、明示 model もない場合は起動前に設定エラーになります。CI / headless では user config・Pi settings・認証情報を手動で用意できます。API key は `ensemble auth login --api-key-stdin` から user 層に保存できます。OAuth と TTY prompt には TTY が必要です。手順は [Pi conductor セットアップと認証](https://github.com/otolab/agents-ensemble/blob/main/docs/pi-conductor-setup.md) を参照してください。

Pi の認証 CLI は backend に分岐します。Cursor は Cursor SDK のログイン、Pi は provider 単位のログインです。Pi OAuth は SSH / tmux の TTY から進められ、URL は OSC 8 非対応端末でもコピーできる形で表示します。貼り付ける authorization code は入力中に表示しません。TTY の動作、OAuth の stderr 出力、project OAuth の制約、認証優先順、復旧手順は [Pi conductor セットアップと認証](https://github.com/otolab/agents-ensemble/blob/main/docs/pi-conductor-setup.md) を参照してください。

Pi は headless の `createAgentSession` を使い、Pi CLI の `<cwd>/.pi/` 設定とは独立しています。resource discovery、`settings.json` の headless 対応範囲、`models.json`、MCP の制約は [config.md](https://github.com/otolab/agents-ensemble/blob/main/docs/config.md) と [ADR 0025](https://github.com/otolab/agents-ensemble/blob/main/docs/adr/0025-conductor-agent-backend-sdk-and-pi.md) を参照してください。

headless conductor の設定キーと create / reload / resume の適用範囲は [config.md の headless 対応範囲](https://github.com/otolab/agents-ensemble/blob/main/docs/config.md#settingsjson-の-headless-対応範囲) を参照してください。

Pi の MCP transport、OAuth、resource tools、resume 時の制約は [ADR 0025](https://github.com/otolab/agents-ensemble/blob/main/docs/adr/0025-conductor-agent-backend-sdk-and-pi.md) にまとめています。

backend はセッション開始時に選択され、resume の途中では切り替えられません。system prompt の渡し方、認証、resume の差分は [ADR 0025](../adr/0025-conductor-agent-backend-sdk-and-pi.md) にまとまっています。

backend を選んだ後の主経路は共通です。リポジトリのディレクトリで、対象 Issue を同じ `ensemble issue <url>` コマンドに渡します。

## 認証後の設定調整 — `ensemble doctor`

`ensemble setup` は conductor backend の選択と conductor 認証を準備する入口です。認証後の `ensemble doctor` は、同じ conductor backend を使う独立した対話 configurator として、worker preset や Issue 実行時の設定を確認・提案します。Issue session、team profile の実行、worker の起動は行いません。doctor が読める・変更できるのは、secret を含まない許可済み config 項目だけです。Pi backend では Pi user/project の prompt template と skill 本文を読み込まず、`/name`・`/skill:name` の展開も無効にします。doctor 専用の role/materials は引き続き system prompt として使います。書き込み前には変更内容と保存先を TTY に表示して同意を確認します。

`ensemble doctor check` は設定を変更しない非対話診断です。team profile や Issue session を読み込まず、conductor backend / 認証情報の有無、worker adapter / CLI の PATH 前提、secret を含まない許可済み config 項目を確認します。worker CLI の認証や GitHub のログイン状態は検証しません。

```bash
# 引数なし: harness が把握できる基本情報のみ。agent / model は起動しない
ensemble doctor check
ensemble doctor check --json

# 自然言語の依頼を指定した場合だけ、read-only diagnostic agent が1 turn動く
ensemble doctor check "why is the worker preset unavailable?"
ensemble doctor check --json "review the effective worker and GitHub config"
```

自然言語 request は positional arguments を空白で結合して渡します。option のように始まる request は `--` の後ろに置いてください。`--repo-root <path>` で対象 repository を指定できます。request を省略すると、どの backend でもモデル解釈・agent/model 起動・model catalog を含む追加 network 操作はありません。request がある経路は Pi backend のみで受け付け、既存 conductor auth context を使って read-only 診断 agent を1 turnだけ実行します。Cursor backend では認証の有無にかかわらず agent を起動せず、`backend_unsupported` / exit code 2 を返します。auth がない場合も、report には auth failure と `ensemble auth` / `ensemble setup` の next action を残したうえで exit code 2 を優先します。どちらの backend でも、設定書き込み、TTY prompt、worker 起動は行いません。Pi backend では Pi user/project prompt、skill、extension、internal MCP、Codemode、Tool Search を診断 agent に渡しません。

`--json` は harness が組み立てる固定 schema の report を出力します。`schemaVersion`、`mode`、機械診断の `checks`、agent の `started` / `turns` / `answerCode` / `answer` / `answerStatus`、`nextActions`、`exitCode` を含みます。agent は最終応答として有限な診断コードを1つだけ返します。harness はコードを完全一致で検証し、チェック状態または secret を含まない allowlist 設定値から固定文を生成します。モデル出力を JSON schema や check status として解釈せず、自由文を直接出力することもありません。未知・不正な応答は固定の generic 診断文に置き換えます。`answerStatus` は、request なしなら `not_requested`、request を実行できないか完了できなければ `unavailable`、既知コードから診断文を生成した場合は `mapped`、未知・不正な応答を generic 文に置き換えた場合は `generic` です。自然言語 request 自体は report に含めず、credential、token、`acp.env` などの secret-bearing 値も出力しません。終了コードは `0` が check 成功、`1` が check failure（Pi backend の auth 不在を含む）、`2` が CLI usage error、Cursor backend の自然言語 request、または診断を完了できない実行エラーです。認証がない場合は非ゼロで終了し、`ensemble auth status` / `ensemble auth login` / `ensemble setup` を次の action として示します。

例えば request が worker preset の値を尋ね、agent が `config.acp.defaultPreset` を選ぶと、harness は allowlist snapshot から実際の値と source を取り出して固定文にします。自由文やモデルが返した設定値をそのまま表示することはありません。

設定の保存先は user config が既定です。対象 repository の `.ensemble/config.yaml` に保存する場合だけ `--project` を明示します。doctor は secret を尋ねたり表示・保存したりしません。worker CLI の認証は [ADR 0028](../adr/0028-authentication-delegation-and-ensemble-auth.md) に従って各 CLI に移譲されるため、必要な場合はその CLI 側で準備してください。

```bash
# 対話 configurator（user config への保存が既定）
ensemble doctor

# 対象 repository の project config に保存することを許可
ensemble doctor --repo-root /path/to/repository --project
```

設定項目と解決順は [設定値リファレンス](../settings.md) と [ensemble 共通設定](../config.md) を参照してください。

## permission 停滞警告の閾値

`ensemble issue` の `--permission-deadlock-stall-ms <n>` で、worker の permission が停滞したときに警告・conductor 通知を出すまでの時間を上書きできます。既定値は **`300_000ms`（300 秒）**です。設定値の解決順と API 名は [設定値リファレンス](https://github.com/otolab/agents-ensemble/blob/main/docs/settings.md) を参照してください。poll 間隔と worker UI の挙動はこのオプションでは変更しません。

## dispatch hold reminder の間隔

dispatch hold が続く間、harness は既定 **30 分ごと**に、held buffer の件数と解除を促す reminder を operator 向け telemetry として表示します。`ensemble issue` の `--dispatch-hold-reminder-ms <n>` で間隔を上書きできます。通知のみで、自動解除はしません。詳細と API 名は [設定値リファレンス](https://github.com/otolab/agents-ensemble/blob/main/docs/settings.md) を参照してください。

## 最小クイックスタート

初回だけ、worker・選択した conductor backend・GitHub API の認証を準備します。

既定の worker ACP preset は引き続き `cursor` です。npm パッケージに含まれない Cursor Agent CLI の `agent` コマンドを使うため、先に [Cursor Agent CLI の公式インストール手順](https://cursor.com/docs/cli) に従ってインストールしてください。これは conductor の既定 backend Pi とは別の設定です。

| 対象 | 準備 |
|------|------|
| conductor（Pi、既定。clone 後の初期設定） | `ensemble setup`（TTY で Pi/OpenAI または Cursor を選択。Pi では OAuth / API key も選択） |
| worker（既定の Cursor ACP） | `agent login` |
| worker（Pi BYO） | PATH 上の Pi CLI と、その Pi runtime の provider 認証 |
| worker（Pi builtin） | `acp.defaultPreset: pi` と `acp.pi.runtime: builtin` を設定。Pi CLI の追加 install は不要。provider credential は Pi user config または provider 環境変数で用意。`ensemble auth login --provider <id>` を使う場合は、選択中の conductor backend / profile も Pi にする |
| conductor（Cursor SDK、明示選択） | `ensemble auth login` |
| conductor（Pi、OpenAI API key） | TTY: `ensemble auth login --provider openai --api-key-prompt`、非 TTY: `ensemble auth login --provider openai --api-key-stdin`。user `auth.json` に保存し、`ensemble setup` でも選択可能 |
| conductor（Pi、他 provider の API key） | TTY: API-key-only provider は `ensemble auth login --provider <id>`、OAuth 共存 provider は `ensemble auth login --provider <id> --api-key-prompt`。非 TTY: `ensemble auth login --provider <id> --api-key-stdin` |
| conductor（Pi、既存 command credential） | `ensemble auth set-command --provider <id> -- '!command'`。既定で user `settings.json` に保存。project 保存は `--target project` を明示 |
| conductor（Pi、OAuth の再 login） | `ensemble auth login --provider <id>`（TTY。URL / device code は stderr、authorization code は非表示 prompt。OpenAI は既定で OAuth） |
| GitHub API（gh CLI を使う場合） | `gh auth login` |

```bash
# worker（既定の Cursor ACP。conductor backend とは独立）
agent login

# clone 後の conductor 初期設定（TTY。Pi/OpenAI または Cursor を選択）
ensemble setup

# conductor（Cursor SDK を選択した場合の再 login）
ensemble auth login

# conductor（Pi provider を再ログイン。OpenAI は既定で OAuth）
ensemble auth login --provider <provider-id>

# conductor（OpenAI API key を TTY の非表示 prompt で保存）
ensemble auth login --provider openai --api-key-prompt

# conductor（API key を stdin から非対話で保存）
secret-manager read <secret-name> | ensemble auth login --provider <provider-id> --api-key-stdin

# Pi の既存 command credential を user settings.json に登録・確認・削除
ensemble auth set-command --provider <provider-id> -- '!printf token'
ensemble auth status --provider <provider-id>
ensemble auth clear-command --provider <provider-id>

ensemble auth status
ensemble models list
ensemble models show

# GitHub API（gh CLI を使う場合）
gh auth login
```

GitHub API トークンを直接渡す場合は、`gh auth login` の代わりに `GITHUB_TOKEN` または `GH_TOKEN` を設定してください。

Pi builtin worker は Pi conductor と同じ user resource root（`conductor.pi.agentDir` > `PI_CODING_AGENT_DIR` > 既定 `~/.ensemble/pi/`）にある `auth.json` と Pi の provider 環境変数を使います。worker の session map と transcript は root override にかかわらず `~/.ensemble/pi/worker/<repoKey>/issue-<issueNumber>/<workerKey>/` に分離されます。同じ repository で別 Issue の同名 worker を同時に動かしても、session map と transcript は共有しません。Pi CLI とその shell command には利用者の `HOME` / `USERPROFILE` が渡るため、Git identity、SSH 設定・key、GitHub CLI 設定などは通常の user home から読み込まれます。別の home を使う場合は `acp.env.HOME` または `acp.env.USERPROFILE` を指定してください。`ensemble auth login --provider <id>` は選択中の conductor backend に従います。Cursor を config / profile で選んでいる場合、`--provider` だけでは Pi login に切り替わらないため、Pi backend を選ぶか Pi CLI の provider 環境変数を設定してください。Pi worker に使える credential がない場合、初回 attach は `AUTH_REQUIRED` で失敗します。

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

## worker の Bash command に一度だけ secret を渡す

Issue session 中、worker の Bash から待機 command を起動します。secret 値は worker や conductor への指示に書かず、`ENSEMBLE_SECRET_*` の実行 helper から target process の環境変数へ渡します。

```bash
# worker が実行する command。値を含めず、対象だけを指定する
"$ENSEMBLE_SECRET_NODE" "$ENSEMBLE_SECRET_CLI" secret exec \
  --label staging-api --env API_TOKEN -- \
  curl -fsS https://api.example.test/
```

harness の `[harness] secret.request` 行に worker、secret の表示名、環境変数名、実行 command と引数、cwd、有効期限、socket path、request ID が出ます。全項目を確認した上で、オペレータ自身が管理する信頼済み credential source の stdin を `ensemble secret push` へ接続してください。

```bash
credential-source-command | ensemble secret push '<socket path>' '<request ID>'
```

`secret push` は `/dev/tty` に対象情報を再表示し、`y` の入力を受けるまで stdin を読みません。worker が渡した表示値は harness log と同じ terminal control / bidi escape を適用してから出すため、制御文字で項目順や画面表示を偽装できません。この操作が worker、secret の表示名、env 名、command / argv、cwd と、一回だけの投入を承認します。`y` 以外で断ると待機 request も消費し、worker の command は実行されません。もう一度試す場合は worker に新しい `secret exec` request を作らせてください。これは secret の投入に対する明示的な operator approval です。Bash command 自体には、既存 ACP backend の permission 処理も引き続き適用されます。TTY が使えない場合は失敗し、予約済み request を消費します。値を shell argument、Issue、PR、モデルへの指示、通常の shell variable や `SEC=$(...)` の出力へ置かないでください。

この保証は push CLI が stdin を読む時点についてのものです。shell は pipeline を作るときに上流の `credential-source-command` も起動するため、TTY 承認より先に値を取得・出力したり、副作用を起こしたりする場合があります。承認前の起動や pipe buffer への出力を避ける必要がある source command は、この形で実行しないでください。上流 source の実行時期と副作用を理解し、信頼できるものだけを使ってください。

入力は **空でない UTF-8、最大 64 KiB、NUL byte なし**に限ります。改行や末尾改行はそのまま保持し、trim しません。binary 値、NUL、空値、上限超過、期限切れ、不正 ID、二重投入、worker 切断時は command を実行しません。request は120秒で失効し、同じ worker の待機は同時に一件まで、session 全体では最大8件です。secret の投入後に起動確認が届かない場合は結果が不明です。その場合は再投入せず、target の状態を調べてください。起動前の失敗は固定の generic error として表示し、backend の例外本文は出しません。

承認画面・stdin 読取中に SIGINT / SIGTERM で中断すると、CLI は予約を abort して待機 request を消費してから終了します。abort の応答を確認できない場合はその旨を表示し、request は最大120秒の期限切れまで残る可能性があります。submit を始めた後は安全に取り消せません。中断や接続切断で応答が得られない場合は「結果不明」と表示します。target がすでに起動している可能性があるため、再投入せず target の状態を確認してください。submit 開始後に起動確認を受け取れた場合は、その確認を優先して起動成功を表示します。

この機能は macOS / Linux 上の組み込み `cursor` / `claude` / `codex` / `pi` ACP preset を対象にし、custom ACP と Windows / 他 OS では有効にしません。harness は Issue worker の ACP process に CLI と Node の絶対 path、worker token、owner-only Unix socket を設定します。Pi BYO / builtin はどちらも ACP process の environment から Pi CLI の child process へ継承します。Claude ACP / Codex ACP の現行 adapter も process environment を child に継承します。Cursor は外部 `agent acp` CLI の内部実装に依存します。Bash tool が helper 用 environment を引き継がない環境では helper は target を起動せず失敗します。`ensemble` が worker の Bash `PATH` にあることには依存しません。custom backend で動かすために環境を手動追加する設定はありません。

対象は、利用者が環境変数で credential を受け取ると確認できる信頼済み command 一回分です。credential を argv / stdin で受け取る CLI、対話的なログイン、長時間または複数 command にまたがる credential 利用には使わず、それぞれの既存の認証経路を使ってください。特に command が credential を標準出力・標準エラーへ書くと worker の会話に漏れるため、その動作をしない target を選びます。

### 選択肢と信頼境界

| 方式 | secret の流れ | 向いている用途 / 残る制約 |
|------|----------------|----------------------------|
| `SEC=$(ensemble secret ...)` | 値が CLI stdout、shell command substitution と変数を通る | 採用しません。Bash tool の出力・trace・後続展開へ値が混ざり、モデルやログへ出る可能性があります。CLI が Bash 内にある保証にも依存します |
| harness が各 Bash 呼び出しの env に直接注入 | 値を ACP backend ごとの Bash 起動時に注入 | 理想的ですが、現行 ACP API と `cursor` / `claude` / `codex` / `pi` の組み込み adapter に共通する per-command spawn hook がありません。adapter ごとの fork / hook が必要になり、現時点では実装できません |
| `secret exec` helper | オペレータ stdin → harness の一時 IPC → helper process → 指定 target child の env | 上の例のように、固定 command 一回だけに secret を渡す用途。Bash runtime 自体へ値を返さず、absolute CLI path で backend Bash の PATH に依存しません。target とその子孫は値を読めます |

socket directory / socket の mode は `0700` / `0600`、request ID と worker token はそれぞれ暗号学的乱数 256 bit です。ID は request を照会する locator であり、単独では人間の承認や OS 身元の証明になりません。request 作成時は per-worker token を検証し、label / env / command / argv / cwd をその request に固定します。Node の portable Unix socket API は peer PID / UID を検証しないため、同じ OS user の process は trust boundary 内です。同じ user の悪意ある process は socket に直接接続し、`secret push` の TTY 確認を経ずに任意値を submit して待機 command を起動したり、request を先取り・失効させたりできます。また worker は同一 user の権限で動くため、process environment / memory を調べて値を漏らす可能性があります。したがって `y` 確認は通常の operator workflow を守るゲートであり、同一 UID の敵対 process に対する認証ではありません。この機能は OS sandbox ではなく、そのような process から値や実行権限を隔離する保証はありません。

secret byte 列を SessionResumeStore、SessionSummary、SessionLogEvent、Issue / PR、command argument へ保存・出力しません。session log には request metadata、socket path、request ID が出るため、session 中に収集した stderr / TUI capture は有効中の request へ接続可能な情報を含みます。harness は secret を JavaScript memory、IPC message、target environment に一時的に保持します。IPC の受信 fragment、連結前の application-owned Buffer、応答 body Buffer は、連結・close・timeout・error 時に best-effort で上書きします。socket から Node が渡す chunk、JSON parse が作る string、Node / OS 内部のコピーを完全消去する保証はありません。Buffer の上書きも OS process memory まで及ぶ保証ではありません。target program は secret を保存・出力・送信でき、target の stdout / stderr は worker の Bash 経由でモデルに見えることがあります。子孫 process は通常 target の environment を継承します。信頼できる target と credential source に限って使い、secret を表示しない target を選んでください。

### operator-agent

複数の Issue session を TTY から監督する場合は `ensemble operator-agent` を使います。起動元 directory、repository の `.ensemble/`、generic team profile、`~/.ensemble/config.yaml` には依存せず、設定は `~/.ensemble/operator-agents.config.yaml`、選択 profile の workspace は `~/.ensemble/operator-agents/<profile>/` に置きます。operator-agent に `--repo-root` / `--config` はありません。`ensemble issue --repo-root` と `ensemble issue --config` は従来どおりです。

```bash
ensemble operator-agent
ensemble operator-agent --profile work
ensemble operator-agent --repo-filter otolab/agents-ensemble --repo-filter 'example/*'
ensemble operator-agent --resume operator-<id>
ensemble operator-agent --new
```

profile は `--profile` > `ENSEMBLE_OPERATOR_AGENT_PROFILE` > 選択した保存会話の profile > `defaultProfile` > profile が一つだけならその profile > TTY 選択の順で決まります。backend / model / reasoning は、それぞれ専用の `ENSEMBLE_OPERATOR_AGENT_BACKEND` / `ENSEMBLE_OPERATOR_AGENT_MODEL` / `ENSEMBLE_OPERATOR_AGENT_REASONING` > profile > `common.conductor` > 既定値の順です。MCP は profile の `mcp.servers` > `common.mcp.servers` の順で選択し、profile に空配列を指定すると MCP を無効にします。選択された名前の定義だけを `~/.ensemble/mcp.json` から読み、起動 repository の `.agents/mcp.json` や `.ensemble/` は参照しません。generic `CONDUCTOR_*` は参照しません。以前 project config や team profile にだけ設定していた operator 用 backend / model / prompt / Pi resources は自動変換されないため、専用 config へ手動で移してください。Pi は共通 user resource root と選択 profile の明示 root だけを読み、起動元 repository の `.ensemble/pi/` や Pi の cwd 自動探索は使いません。設定例は [operator-agent 専用設定](../config.md#operator-agent-専用設定)、Pi の詳細は [Pi resources](../pi-conductor-setup.md#operator-agent-の-pi-resources) を参照してください。

session list は user store 内の全 canonical GitHub slug group を既定 scope とし、GitHub API で repository を列挙しません。profile の `include` と複数の `--repo-filter <owner/repo|owner/*>` を指定すると、両者の一致を取り、同じ項目内ではいずれかの filter に合う repository を対象にします。list tool は `limit` / `cursor` / `nextCursor` で続きのページを返し、件数上限で結果を黙って捨てません。

選択 profile の workspace 直下に `AGENTS.md` を置くと、起動時に `prompt.instructions` に続けて読み込みます。実行中の編集は次回起動・resume 時に反映されます。読み込みエラーは起動を失敗させます。Pi と Cursor の resume 時の違いや読み込み条件は [operator-agent 専用設定](../config.md#operator-agent-専用設定) を参照してください。

会話 record は repository や profile に結び付けず、`operatorAgentId` ごとに `~/.ensemble/operator-agents/conversations/<operatorAgentId>/conversation.json` へ保存します。起動時は `--resume <operatorAgentId>` で指定でき、保存会話が一件なら自動再開、複数なら TTY で選択します。`--new` は別の会話を作り、既存 record を消しません。Pi transcript も会話 ID ごとに同じ directory の `pi-sessions/` に保存します。起動 cwd が変わっただけでは再開を拒否しません。再現できない context / resource は通知した上で選択中設定による再開を試し、backend が復元できない場合は失敗します。その場合も既存 record は保持します。`/exit` は現在の record だけを削除し、Pi transcript を削除しません。

Pi の古いバージョンで tool call が省略され、その結果だけが残った会話は、更新後も自動修復されません。再開後の発話で `No tool call found for function call output` が繰り返される場合は、operator-agent を終了して `ensemble operator-agent --new` で新しい会話を始めてください。元の会話は保持されますが、新しい会話には履歴が引き継がれません。必要な情報は別途引き継いでください。

#### profile workspace のファイル操作

operator-agent は `read_operator_workspace_file` / `write_operator_workspace_file` custom tool で、選択中 profile の workspace（`~/.ensemble/operator-agents/<profile>/`）内にある UTF-8 file を読み書きできます。path は workspace からの相対 path に限られ、directory 構造が操作中に変わらない通常の状態では、絶対 path、`..`、symlink の解決先が workspace 外になる path は拒否されます。write は workspace 内に必要な親 directory を作成し、既存 file を置き換えます。read / write とも 1 file あたりの上限は 1 MiB です。`list_operator_workspace_files` は指定 directory（省略時は root）を一覧し、entry の種類・size・mtime を返します。再帰は任意で、深さは既定 3・最大 10、件数は既定 100・最大 1000 です。再帰時に symlink は辿りません。`move_operator_workspace_file` は file / directory を移動し、親 directory を必要に応じて作成します。移動先が存在する場合は既定で拒否し、`overwrite: true` で置き換えます。最終 symlink の移動・上書き、directory の自己配下への移動は拒否します。異なる filesystem 間では移動先側にコピーしてから元を削除します。協調する operator-agent の workspace 操作は profile ごとに直列化します。workspace lock を取得できない場合は約 1 秒で失敗します。watch は workspace lock の後に watch lock を取得します。move の前に workspace 外の親 directory に記録を作り、中断・失敗時は通常の workspace file tool を停止します。`get_operator_workspace_move_status` は source / destination / staging の相対 path と記録のファイル名を返します。staging の `backup` は旧移動先、`copy` はコピー途中の可能性があるデータです。source も削除途中の場合があります。自動で復元・採用はしません。operator は全 agent を停止し、`ensemble operator-workspace-maintain --profile <name>` を実行してください。コマンドは workspace lock を保持し、記録と各 path を表示します。コマンドを開いたまま別端末でデータを安全な場所に保全し、完了後に `COMPLETE` と入力すると記録を削除して lock を解放します。それ以外の入力や中断では記録を残します。記録が破損している場合も自動で取り除かず、周辺の staging を手動で調べてください。停電・kernel crash に対する永続性と、旧版・外部 process・MCP・直接の filesystem 操作など共通 lock に参加しない操作は保証しません。network filesystem での lock の信頼性も保証しません。workspace の親 directory にある `.ensemble-workspace-lock-*.sqlite` とその補助ファイルは、agent や保守コマンドの稼働中に削除・移動・置換しないでください。lock DB が削除・交換されると、別 process が別の DB に lock を取得し、同時操作によるデータ損失が起こり得ます。破損した DB は操作を拒否する場合があります。保全中に外部から記録を削除しないでください。watch の管理データを守るため、workspace 直下の `watch/` とその内部は write / move / delete できません。workspace 内 symlink 経由で watch の解決先を変更する操作や、その解決先の親 directory の移動も拒否します。利用者が watch 内に置いたファイルも変更できません。read / list は可能です。事前に外部で作られた hard link や複雑な symlink の別名は保護の対象外です。write は既存 file を更新するため、hard link の共有先にも変更が反映されます。`delete_operator_workspace_file` は file または symlink 自体を削除し、directory は空でも削除しません。root および root 直下の `AGENTS.md` は move / delete できません。

各 file 操作は realpath などで path を検査してから、path-based filesystem 操作を行います。その間に同一ユーザーの別 process が workspace root や親 directory を差し替える競合（TOCTOU）は防止できず、競合時に workspace 外へのアクセスを防ぐ保証はありません。この機能は OS-level sandbox ではなく、同一ユーザーで動く任意 process を保護対象にしていません。信頼できない同一ユーザー process と profile workspace を共有しないでください。Pi sandbox plugin が利用可能になった段階で適用を検討する方針ですが、現時点では適用していません。

directory 構造が変わらない通常の状態では、path 検査により Issue worktree、別 profile、`~/.ensemble/sessions/` へのアクセスを拒否します。operator-agent は backend の built-in coding tools と Pi の user extensions を無効にします。明示選択した MCP server は別経路で接続され、その tool が server process と外部サービス側で持つ権限は workspace file tool の path 制限を受けません。MCP の選択や `builtinTools: false` は OS sandbox ではありません。信頼できる server だけを選び、server process が実行する command、環境変数、接続先サービスの権限を確認してください。

file の内容は redaction されず、読み出した内容はそのまま選択中 backend に渡ります。API key、token、password、credential などを workspace file に保存したり、秘密情報を含む file を agent に読ませたりしないでください。

旧 profile-less operator conversation log は新しい record へ自動移行せず、resume も保証しません。#698 の copy-only migration は Issue session data と watch state の inventory / copy に利用できます。全 checkout を列挙してから dry-run manifest を確認し、必要な場合に `--apply` で移行してください。migration は source を削除・rename せず、異なる destination を上書きしません。手順と保全条件は [session data の migration 手順](../session-logging.md#legacy-data-の一括-inventory-copy) を参照してください。

## 保存済み session の閲覧

`ensemble session` は、保存済み conductor / worker session をローカルから読み取る CLI です。agent との会話、harness や ACP の起動、session への再接続は行いません。`operator-agent` が LLM と対話し、複数 session の監視や conductor への操作を担うのに対し、`ensemble session` は保存データを表示するだけです。

```bash
# ローカルに保存された全 repository の session を一覧する
ensemble session list

# repository / Issue で絞り込む（--github-repo も指定可能）
ensemble session list --issue-url https://github.com/OWNER/REPOSITORY/issues/123

# session ID で読むコマンドは repository scope を明示する
ensemble session show <conductorAgentId> --github-repo OWNER/REPOSITORY
ensemble session show <conductorAgentId> --issue-url https://github.com/OWNER/REPOSITORY/issues/123

# session をまとめてオフライン調査する
ensemble session export <conductorAgentId> --github-repo OWNER/REPOSITORY --output ./session-bundle

# 終了時 summary も bundle に保存し、その summary で timeline を確認する
ensemble session export <conductorAgentId> --github-repo OWNER/REPOSITORY \
  --summary ./session-summary.json --output ./session-bundle-with-summary
ensemble session timeline <conductorAgentId> --github-repo OWNER/REPOSITORY \
  --summary ./session-bundle-with-summary/inputs/session-summary.json

# Pi / Cursor の conductor 会話履歴を見る
ensemble session messages <conductorAgentId> --github-repo OWNER/REPOSITORY

# worker の既知の session 世代を古い順に確認する
ensemble session workers generations <conductorAgentId> \
  --github-repo OWNER/REPOSITORY --worker implementer

# 世代番号を指定して旧 session の会話履歴を見る
ensemble session workers messages <conductorAgentId> \
  --github-repo OWNER/REPOSITORY --worker implementer --generation 1

# workspace session も URL を指定して世代を選べる
ensemble session workers generations <conductorAgentId> \
  --issue-url <workspace-session-url> --worker implementer

# Pi ACP worker の会話履歴を見る
ensemble session workers messages <conductorAgentId> \
  --github-repo OWNER/REPOSITORY --worker implementer

# 保存データ・終了サマリ・captured stderr を send 番号で照合する
ensemble session timeline <conductorAgentId> \
  --github-repo OWNER/REPOSITORY \
  --summary session-summary.json \
  --harness-log harness.log
```

`session list` は省略時に全てのローカル canonical GitHub slug group を対象にし、GitHub API で repository を探索しません。`--github-repo <owner/repo>`、`--issue-url <url>`、`--conductor-agent-id <id>` で絞り込めます。`--limit <n>`（1〜500）と返された `nextCursor` を使ってページを取得できます。session ID を受け取る `show` / `export` / `messages` / `workers generations` / `workers messages` / `timeline` は、`--github-repo` または `--issue-url` が必須です。ID だけから repository を推測しません。両方を指定でき、異なる repository slug を指す場合はエラーになります。

`--repo-root <path>` は各 subcommand で指定できます（既定値は現在のディレクトリ）。session data の保存・通常読み取りは canonical slug を使い、`--repo-root` は clone 固有の実行 context / Pi の transcript 内 CWD 判定に使います。path-hash や project-local legacy data は通常読み取りません。各 subcommand の `--json` は JSON を出力します。テキスト表示は `NO_COLOR` が空でない値に設定されていると色を使いません。

`list` は user root の canonical GitHub slug に保存された SessionResumeStore の要約を更新時刻の新しい順に返します。slug 配下では保存時の `repoRoot` が現在 clone と一致するかを条件にしません。path-hash / project-local Store は通常の列挙対象ではありません。`show` は sidecar の許可したメタデータ、sidecar と関連 YAML のパス、Open Questions の件数、session-state の報告時刻・履歴件数を表示します。worker ごとに保存 preset と transcript reader の対応状況も表示します。ここで示すのは preset に対する reader の有無で、transcript file が現在読み取れるかまでは確認しません。

長い session の横断調査・共有・スクリプト化では `session export` を使い、bundle をオフライン調査の正本にしてください。`list` / `show` と live の `messages` / `workers messages` / `timeline` は必要な箇所を素早く確かめる quick peek 用です。

`export` は読み取り専用で、`--output <dir>` に新しい bundle directory を作ります。既存の出力先は上書きせず、エラーにします。`manifest.json` は session ID・Issue URL・`repoRoot`・`conductorCwd`・backend・worker / preset・ensemble / CLI version を記録し、入力ごとの状態、bundle 内相対 path、byte size、SHA-256 を一覧します。manifest 自体は自己参照を避けるため hash 一覧から除外します。

bundle には SessionResumeStore の raw JSON、ハーネスの `session-state.yaml` / `open-questions.yaml`、各 worker の全文 reader 結果 JSON（`messages` の 100 件制限なし）を収録します。worker JSON には元 transcript の絶対 path も含まれます。conductor の失敗ログがあれば `harness/conductor-failures.jsonl` として含めます。Pi conductor は canonical slug の Pi transcript だけを探して raw JSONL をコピーします。Cursor conductor は SDK から取得できた run metadata と conversation snapshot を `conductor/cursor-runs.json` に収録します。`--include-tool-calls` を指定すると `.tool-calls` もコピーし、`--summary <path>` / `--harness-log <path>` を指定すると、それぞれの入力を bundle に含めます。これらの相対 path は CLI を実行した directory 基準です。

export した summary は `inputs/session-summary.json` に置かれ、上の例のように `timeline --summary` へ渡せます。timeline は summary file を bundle から読みますが、SessionResumeStore と provider history は実行環境から別途読み取ります。bundle だけを渡して timeline を完全にオフライン再生する機能ではありません。

export は raw のままコピーし、API key・token・password、会話中の秘密値や tool 出力を自動 redaction しません。bundle と manifest の絶対 source path は機密情報として扱ってください。Issue / PR・ログ・集計先へ載せる前に利用者側でサニタイズしてください。

出力 directory と file の権限は OS によって異なります。POSIX では directory に `0700`、file に `0600` の mode bits を設定します。Windows では Node.js の `fs` mode で変更できるのは書き込み権限だけで、owner / group / others を区別できません。exporter も Windows ACL を設定・検証しません。新しく作成する bundle は親 directory から継承される ACL に従うため、owner-only は保証されません。Windows で使う場合は、意図した利用者だけにアクセスを許す ACL を設定した保存先を選び、必要に応じて ACL を確認してください（[Node.js `fs` の file modes](https://nodejs.org/download/release/latest-jod/docs/api/fs.html#file-modes)、[Windows file security](https://learn.microsoft.com/en-us/windows/win32/fileio/file-security-and-access-rights)）。

raw copy では symlink と通常 file 以外の source を追いません。任意 source、補助 YAML、Pi / Cursor / worker transcript が見つからない・読めない場合も bundle は作成し、manifest に status と warning を残します。ResumeStore が見つからない場合は export error です。harness phase が `running` / `idle` の session は process が稼働中の best-effort snapshot として warning を記録し、export 結果の status は `partial` になります。ファイル間の同時点性や Pi JSONL の書き込み競合がないことは保証しません。

`messages` は保存 session の `conductorAgentId` と明示した repository scope を使い、operator-agent の `list_conductor_messages` と同じ core provider-history API を使う quick peek 用コマンドです。Pi transcript は canonical slug の user 層 `~/.ensemble/sessions/github.com/<owner>/<repo>/pi/`（user root を変更している場合はその配下）だけから読みます。Pi `SessionManager` の cwd には保存済み `conductorCwd` を使います。未移行の path-hash / project-local transcript は履歴に現れません。必要なデータは [legacy data の一括 inventory / copy 手順](../session-logging.md#legacy-data-の一括-inventory-copy)で移行してください。既定では新しい履歴から20件、最大100件を表示します。`--limit <n>`、`--order asc|desc`、`--cursor <providerId>` でページを指定できます。返すのは user inbound と conductor の最終応答で、tool output や thinking は含みません。本文は保存値のまま出力し、テキスト表示も `--json` もサニタイズしません。API key・token・password などを会話に入力していた場合、その値も出力されます。`messages` は raw debug 経路を保ち、sanitizer の CLI option は設けていません。アプリから core API を使う場合は、返却前に `inbound` / `text` へ利用側の sanitizer を渡せます。適用境界、エラー時の動作、秘密値保護の限界は [provider history list の API 契約](../live-open-question-control-api.md#operator-agent-の-provider-history-list)を参照してください。

`workers generations` は保存済みの世代を古い順に JSON で表示します。番号は 1 から始まり、最後が現在の session です。`workers messages --generation <番号>` で表示された世代を指定でき、省略時は現在の session を読みます。旧形式の store に記録がない過去世代は推測できません。選択した世代の provider データが欠落している場合や reader が非対応の場合は理由を表示します。世代と参照先の詳細は [session logging](../session-logging.md) を参照してください。

`workers messages` は保存済み ACP session を `--worker <name>` で指定します。現在オフラインで読めるのは Pi ACP（`pi`）、Codex ACP（`codex`）、Cursor Agent CLI（`cursor`）です。Pi は保存 session ID に対応する JSONL transcript を runtime に応じた session map から解決し、active branch の user / assistant 本文を出します。

Pi worker の runtime は SessionResumeStore の fingerprint から判定します。BYO と runtime marker のない旧 session は従来どおり `~/.pi/pi-acp/session-map.json` を読みます。builtin の Issue session は `~/.ensemble/pi/worker/<repoKey>/issue-<issueNumber>/<workerKey>/.pi/pi-acp/session-map.json` を使い、transcript は同じ Issue / worker directory の `sessions/` にあります。workspace session は `~/.ensemble/pi/worker/<repoKey>/workspace/<slugKey>/<workerKey>/.pi/pi-acp/session-map.json` と同じ worker directory の `sessions/` を使います。以前の共有 builtin map は Issue ごとの map がまだない場合に wrapper がコピーします。元の map と transcript は残し、reader は移行前の共有 map も fallback として読みます。既存 session は旧 transcript path を保ったまま `session/load` と `workers messages` で参照できます。BYO は upstream `pi-acp@0.0.33`、builtin は `pi-acp@0.0.34` を使います。両方とも Pi ACP の既存 JSONL 形式と active branch を使うため、CLI から同じ `workers messages` コマンドで閲覧できます。

POSIX では builtin worker の session directory は `0700`、map / transcript file は `0600` で保存し、wrapper が既存データも起動前に同じ mode へ直します。Windows では wrapper が専用 parent と repository storage tree の DACL を現在の account SID のみに設定し、owner と ACL を読み戻して確認します。設定または確認に失敗すると builtin adapter を起動しません。upstream が指定された map / transcript 保存先内に通常の方法で作るデータには、この ACL が継承されます。対象は worker の map / transcript で、共有 Pi settings / auth root には適用しません。同じ OS account の別 process、管理者 / SYSTEM / backup privilege、ACL を無視する storage、指定先外への書込みや upstream の権限拡大までは保護しません（詳細は [Pi worker runtime](../config.md#pi-worker-runtime)）。

upstream `pi-acp` の ACP `session/list` は worker 用 `PI_CODING_AGENT_SESSION_DIR` を見ず、共有 Pi settings の `sessionDir` を探索します。これは BYO `0.0.33` / builtin `0.0.34` の両方に当てはまります。map がある通常の session は `session/load` で復元できます。map が失われた場合の upstream discovery は builtin transcript を見つけられないことがあります。その場合の builtin resume は失敗として通知し、新しい session に旧 session の resume prompt を送ることはありません。ResumeStore の session ID は保持されます。`workers messages` も map がなければ `unavailable` を返します。

Codex ACP の `sessionId` は Codex thread ID です。Codex CLI は `$CODEX_HOME`（未設定なら `~/.codex`）の `sessions/YYYY/MM/DD/rollout-<timestamp>-<thread-id>[_<rollout-id>].jsonl` に rollout を保存し、archive 済みの rollout は `archived_sessions/` に置きます。相対 `CODEX_HOME` は Codex ACP process と同じく、SessionResumeStore に保存された worker の `acpCwd` を基準に解決します。reader はファイル名から候補を探し、先頭の `session_meta.payload.id` と `cwd` を SessionResumeStore の session ID / cwd に照合します。同一 basename の `.jsonl` と `.jsonl.zst` がある場合は `.jsonl` を優先します。本文には `response_item` の user / assistant message にある `input_text` / `output_text` だけを出し、tool、reasoning、event などは含めません。revert 等で同じ thread ID の rollout が複数見つかった場合は、履歴を誤選択しないよう `unavailable` にします。`.jsonl.zst` の圧縮 rollout は Node.js 22.15.0 で experimental として追加された `node:zlib.createZstdDecompress()` が使える場合に読めます。ACP process の起動、`session/load`、Codex の state DB 参照は行いません。

Cursor Agent CLI の transcript reader は `<cursor-config>/acp-sessions/<sessionId>/meta.json` と `store.db` を探索します。探索 root は `CURSOR_CONFIG_DIR` があればそれを優先し（相対 path は保存済み worker `acpCwd` 基準）、Linux / BSD では `XDG_CONFIG_HOME/cursor`（`XDG_CONFIG_HOME` 設定時）、macOS / Linux / Windows では閲覧 CLI の home 配下 `.cursor` です。Cursor の [configuration docs](https://cursor.com/docs/cli/reference/configuration) は CLI 設定ファイルの既定 root を macOS / Linux で `~/.cursor`、Windows で `%USERPROFILE%\.cursor` とし、`XDG_CONFIG_HOME` は Linux / BSD 向けに案内しています。この公式 root 情報は CLI 設定ファイルのもので、ACP transcript の保存場所や形式を保証するものではありません。reader はこれらの root を探索先として用い、実際の ACP store が別 root にある場合は閲覧 CLI に `CURSOR_CONFIG_DIR` を設定してください。`meta.json` の schema version / cwd と SQLite store 内の session ID を照合し、protobuf の会話データから user / assistant 本文だけを返します。tool call と thinking は含めません。store は read-only で開き、ACP process の起動や `session/load` は行いません。core reader と CLI の統合テストでは、operator から提供された scrubbed Cursor ACP store fixture も読み取ります。この fixture で確認できるのは含まれる保存形式のケースに限られます。内部 SQLite / protobuf 形式は公式に保証されず、Cursor の更新で変わる可能性があります。SQLite 読み取りに必要な `node:sqlite` は Node.js 22.13.0 以降なら標準で利用でき、22.5.0〜22.12.x では `--experimental-sqlite` を付けて起動する必要があります。Node.js 22.0.0〜22.4.x では利用できません（詳細は [Node.js v22 の SQLite API](https://nodejs.org/download/release/v22.23.0/docs/api/sqlite.html)を参照）。

未対応 preset（`claude`、`custom` など）または preset が保存されていない旧 SessionResumeStore は `unsupported` と理由を表示し、終了コード 2 を返します。Pi / Codex の保存 map・rollout、Cursor の `meta.json` / `store.db` の欠落、session ID / cwd の不一致、破損、候補の曖昧さは `unavailable` と理由を返し、終了コード 1 で終了します。JSON では `status` と `reason` を確認できます。`session show` が示す `supported` は preset に対応する reader があることを表し、保存ファイルが現在読めることまでは確認しません。

reader は閲覧 CLI の現在の環境から `CODEX_HOME` / `CURSOR_CONFIG_DIR` を読み、Linux / BSD では `XDG_CONFIG_HOME` も参照します。相対値は保存済み worker `acpCwd` を基準に解決します。未設定時の `~/.codex` / `.cursor` は閲覧 CLI の home（Windows の `.cursor` は `%USERPROFILE%\.cursor` 相当）を使います。worker 起動時だけ別の `HOME` や config directory を指定していた場合、ResumeStore には spawn env の digest しか残らず、元の値や保存先は復元できません。閲覧 CLI に同じ環境を設定しないと、rollout や Cursor store が存在していても `unavailable` になることがあります。

`timeline` は SessionResumeStore、conductor provider history、および任意の SessionSummary JSON / 保存済み harness stderr log を読みます。SessionSummary は `ensemble issue --summary-format json` の終了出力をファイルへ保存したものを `--summary <path>` で指定します。`--harness-log <path>` には、`[harness] conductor.send n=... status=...` と `[harness] conductor.transport.reconnect status=...` を含む stderr log を指定できます。これらのファイルは harness が自動保存するものではありません。summary は `agentId` と `issueUrl` で保存 session を識別し、`repoRoot` は実行時 clone の情報として文字列形式だけを検証します。同じ session を別 clone から resume した場合、summary と Store の `repoRoot` が異なっても読み込み、その差を JSON / text の source 診断に表示します。別 session / Issue の summary と不正な schema は引き続き拒否します。データ源の未指定・読取不能・不正な JSON / schema・session 不一致は JSON / text に source 状態と理由を表示し、対象行がない log は認識件数 0 として示します。

Pi の provider history には `sendCount` がありますが、番号は harness process ごとに 0 から始まるため、resume をまたぐと再利用されます。誤った対応付けを避けるため、対象 session と一致する SessionSummary が読めた場合だけ、summary が表すその run の `startedAt` より後、`startedAt + durationMs` より前に完了した Pi history を send 番号で照合します。clone が異なる summary も、その summary 自身の時間窓で履歴を絞ります。開始・終了時刻と同じミリ秒の履歴は隣接 run と区別できないため照合せず、別枠に表示します。時間窓は生成元 SessionLogger の契約（開始が `Date.now()`、`durationMs` が終了時の `Date.now() - startedAt`）と照合します。相関に使うのは、`startedAt` と導出した終了時刻が `Date.now()` で表せる整数 Unix epoch ms で、`durationMs` が非負の安全な整数としてミリ秒精度を保てる場合だけです。契約や精度に合わない値は理由付きで `unavailable` とし、send 番号では照合しません。Cursor history には同じ番号がないので、時間と provider ID を別々に表示します。provider history は最大100件で、さらに古い履歴は表示されません。

この時間相関は、同じ session の process が重ならず、実行中にシステム時計が大きく変わらない前提です。SessionSummary と provider history には run / process ID や単調時計の時刻がないため、CLI は process の重複や時計の変更を検出できません。負の duration や表現できない時刻は相関を止めますが、前向きの時計変更で生じた範囲内の時間窓は判別できないことがあります。重複実行や時計変更の可能性がある調査では、時間相関を同一 run の証明として扱わないでください。

`--harness-log` には対象 run 1 回分の stderr を指定してください。log に run ID や時刻はないため、指定したログが summary と同じ process のものか CLI は検証できません。reconnect 行は直前に記録された send 行とのファイル内の順序を示すだけで、共通 event ID による対応付けや因果関係を表すものではありません。

Timeline の provider history は成功した user inbound / final response の組を返します。sendCount に対応する組が見つからなくても、raw provider transcript に未対応 entry がないことや、その原因が error / reconnect であることまでは断定できません。通常の保存先には全 SessionLogEvent の履歴がないため、captured log を指定していない場合、reconnect の実行状況は `not-provided` / `not-persisted` として示されます。

`timeline` は provider history と SessionSummary の `lastError` を出力する場合があります。`messages` / `workers messages` と同じく秘密値の redaction はしないため、ローカルの信頼できる端末で使い、結果を共有する前にサニタイズしてください。

`messages` はローカルの信頼できる端末でのデバッグに使ってください。stdout の pipe / redirect 先も生データを受け取ります。結果を Issue / PR、ログ、集計・蓄積先へ転記・保存する前に、利用側でサニタイズしてください。機密値を会話へ入力しない既存の運用方針も引き続き有効ですが、過去の入力を出力時に保護する保証ではありません。

`list` / `show` は保存済みデータの構造化ビューです。許可した sidecar メタデータと YAML の件数・時刻だけを表示し、質問・statusLine・profile 本文や worker session ID は出しません。旧形式に残る ACP 環境変数の平文値も SessionResumeStore の読取 API が除外します。この保護は `messages` と `workers messages` の会話本文には適用されません。

会話画面は Ink TUI で、入力欄が画面下端に固定され、会話・活動ログはその上へ追記されます。入力欄では `ensemble issue` と同じキー操作を使い、`Enter` で送信、`Shift+Enter` で改行します。複数行貼り付けは一つの下書きとして入り、明示的に Enter を押すまで送信されません。ログが増えても編集中の本文とカーソル位置は維持され、agent の応答中も入力できます。端末サイズを変更すると画面とスクロールバックを消去し、会話の活動ログを再描画します。起動前の端末履歴は復元されません。終了時にサイズ変更が続く場合は最大1秒待ち、収束しなければ最後に取得したサイズで画面とスクロールバックを消去し、保持した会話・活動ログを順に再描画して端末を復元します。その後もサイズが変わると最終画面が折り返されることがあります。`user>` / `operator>` は対話、`[harness]` は watch・dispatch・hold の状態と障害、`[observation]` は起動・終了・再接続などの運用通知です。`user>` は控えめに、`operator>` はシアンで表示し、operator の本文は次の行から表示します。監視報告 hold は理由と保留件数を `[harness]` の同じ形式で、状態が変わったときに更新します。`NO_COLOR` が設定されている場合は色を使いません。チャネルの詳細は [セッションロギング](../session-logging.md)、共通の編集キーは [TTY 入力ショートカット](../cli-text-input-keybindings.md) を参照してください。

canonical slug 配下の SessionResumeStore から得られる情報はスナップショットとして読み取り専用です。複数 session の watch は稼働中 harness の `session.observe` を使い、接続不能または未対応時には保存済み Open Questions YAML / session-state YAML / SessionResumeStore を poll して観測元を示します。`list_live_open_questions`、`answer_live_open_question`、`send_operator_message`、`get_last_conductor_message` は稼働中 session の直接 UDS control であり、停止・接続不能時にエラーとなり snapshot へ fallback しません。`get_last_conductor_message` は最後の応答だけを返します。`list_conductor_messages` は provider session history を直接読み、稼働中・停止後とも user inbound と final response の直近100件を上限に返します。Pi は active branch の entry ID と send 完了時刻を使い、Cursor は SDK run order / run ID / 作成時刻を使います。provider store を読めない場合は error になります。発言を継続受信する場合は `register_conductor_message_listen` / `unregister_conductor_message_listen` を使います。listen は稼働中 UDS の新着通知で、停止後 replay はしません。送った指示の後は `get_last_conductor_message` で最後の conductor 成功応答を確認でき、まだ成功応答がなければ `message: null` です。`send_operator_message` は `next`（既定）・`idle`・`interrupt` を指定できます。成功応答はキュー受理を示し、処理完了の確認ではありません。詳細は [稼働中 harness control API reference](../live-open-question-control-api.md)、セキュリティとログの扱いは [session logging](../session-logging.md#4-sessionresumestore-と-open-question-yaml) を参照してください。

初回の作業指示は、Issue 参照の後ろに CLI 引数として渡せます。複数の引数はスペース 1 つで結合され、前後の空白は除かれます。

```bash
ensemble issue https://github.com/OWNER/REPOSITORY/issues/123 受け入れ条件を確認して実装してください
ensemble issue https://github.com/OWNER/REPOSITORY/issues/123 "まずテストから始めてください"
```

これは TTY / 非 TTY の両方で、セッション開始後に 1 回だけ `operator.message` として conductor へ送られます。CLI メッセージと `ENSEMBLE_OPERATOR_MESSAGE` は併用できず、両方が空でない場合は起動エラーになります。`--continue` / `--resume` では CLI メッセージは注入されず、stderr に警告が出ます。詳細は [オペレータ入力](https://github.com/otolab/agents-ensemble/blob/main/docs/operator-input.md) と [設定値リファレンス](https://github.com/otolab/agents-ensemble/blob/main/docs/settings.md) を参照してください。

TTY で worktree とセッション状態を残してプロセスを閉じるには `/close` を入力します。正常に閉じると exit code 0 で終了し、再開するときは同じ Issue に `--continue` を付けます。同じ Issue に複数の保存 session がある場合、`--continue` は `close` / `abort` を優先し、`exit` は候補から除外します。選択規則の詳細は [SessionResumeStore の記録](../session-logging.md#4-sessionresumestore-と-open-question-yaml) を参照してください。`/exit` は isolated worktree の cleanup を試みて終了します（cleanup に失敗しても warning のみで exit code は 0、[#448](https://github.com/otolab/agents-ensemble/issues/448)）。Ctrl+C / SIGINT は `interrupted` として中断し、worktree cleanup を行いません。詳しくは [オペレータ入力](https://github.com/otolab/agents-ensemble/blob/main/docs/operator-input.md) を参照してください。

Conductor send が未完了になった際、TTY では `/recovery list` と `/recovery show <recoveryId>` で、dispatch した operator-authored input を確認できます。対象は Pi API-key resolver failure に限りません。表示内容は再送されず、secret を含む可能性があります。worker / worktree の状態と副作用を確認し、必要な続きを新しい指示として送ってください。非 TTY では本文を確認できず、その旨が内容を含めず通知されます。保持期間と上限は [オペレータ入力](https://github.com/otolab/agents-ensemble/blob/main/docs/operator-input.md) に記載しています。

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
| [conductor 認証再接続](https://github.com/otolab/agents-ensemble/blob/main/docs/conductor-auth-reconnect.md) | reconnect、失敗後の入力確認、再開の設計 |
| [Session usage と終了サマリ](https://github.com/otolab/agents-ensemble/blob/main/docs/session-metrics.md) | 終了時のモデル構成・開始時刻・経過時間と、TTY / JSON の token・cache・cost・compaction 表示および取得範囲 |

GitHub 上の全ドキュメントは [docs/README.md](https://github.com/otolab/agents-ensemble/blob/main/docs/README.md) から参照できます。

`ensemble session scheduling-stats [--profile <name>] [--since <date>] [--until <date>] [--json]` は operator-agent の scheduling 記録を読み取り専用で集計します。集計方法と記録の制約は [session metrics](../session-metrics.md#9-operator-agent-の-scheduling) を参照してください。
