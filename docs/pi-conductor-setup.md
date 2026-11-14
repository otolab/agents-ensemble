# Pi conductor セットアップと認証

> **正本:** `ensemble issue` の Pi conductor を初回設定し、provider 認証を取得・確認・復旧する利用者向け手順。

このガイドは conductor の既定 backend である Pi の設定を説明します。worker の ACP preset `pi` や、Pi CLI の通常の `<cwd>/.pi/` 設定とは別の経路です。

## 最短セットアップ

TTY で初回設定するときは、まず次を実行します。

```bash
ensemble setup
```

backend は Pi（OpenAI）または Cursor から選びます。Pi を選ぶと `openai` / `gpt-6.1-sol` を user Pi settings に保存し、OpenAI の OAuth または API key を選べます。Cursor を選ぶと既存の Cursor SDK login に進みます。認証は既存の `ensemble auth login` と同じ core login に委譲します。API key は入力中に表示されず、POSIX では Pi の user `auth.json` を mode `0600` で保存します。Windows の ACL については[保存先の保護](#保存先の保護)を確認してください。OAuth の URL や device code は stderr に表示します。

設定の書き込み先は user 層だけです。`~/.ensemble/config.yaml` の `conductor.backend` と、Pi を選んだ場合の user `pi/settings.json` に provider / model を保存します。project config、project Pi resource、既存の `conductor.model` は変更しません。project config や選択中 profile が backend を指定している場合はその値が優先されます。Pi の project `settings.json` に provider / model がある場合も user settings より優先されます。setup は検出した競合を表示します。

config や profile に明示的な指定がなければ、Pi conductor が使われます。Pi の `settings.json` に既定 provider / model が必要です。clone 後は `ensemble setup` を実行すると backend、Pi model、認証をまとめて用意できます。Cursor SDK を使う場合は setup で Cursor を選ぶか、config / profile に `conductor.backend: cursor` を設定してください。

`ensemble setup` は TTY 専用です。CI / headless 環境では対話 login を実行せず、user 設定と認証情報を手動で用意してください。

```yaml
# ~/.ensemble/config.yaml
conductor:
  backend: pi
```

user Pi の `~/.ensemble/pi/settings.json`:

```json
{
  "defaultProvider": "openai",
  "defaultModel": "gpt-6.1-sol"
}
```

Pi の認証には `OPENAI_API_KEY` など provider 固有の環境変数、または user Pi `auth.json` の認証情報を使えます。保存先は既定で `~/.ensemble/pi/auth.json` ですが、`conductor.pi.agentDir` で変更できます。手動で credential を置く場合も、secret manager から注入するなどしてファイルを公開・commit しないでください。Cursor は `CURSOR_API_KEY` を設定できます。Pi の OAuth と TTY の API-key prompt、および Cursor SDK の対話 login には TTY が必要です。API key は `ensemble auth login --api-key-stdin` から非対話で user `auth.json` に保存できます。OAuth を使う場合は、対話端末で先に login してください。詳細は[認証の解決順](#認証の解決順)を参照してください。

### 1. Pi backend を設定する

リポジトリの `.ensemble/config.yaml`（またはユーザの `~/.ensemble/config.yaml`）に設定します。

```yaml
conductor:
  backend: pi
```

profile に `conductor.backend` がある場合は profile の値が config より優先されます。backend は既定で Pi なので、Cursor を使う場合だけ `backend: cursor` を明示します。

Pi の設定を置く場所は次の 2 層です。

| 層 | 既定の resource root | 用途 |
|----|----------------------|------|
| user | `~/.ensemble/pi/` | 個人の設定・user credential |
| project | `<repoRoot>/.ensemble/pi/` | リポジトリ固有の model/resource と project credential |

user resource root は `conductor.pi.agentDir` → `PI_CODING_AGENT_DIR` → `~/.ensemble/pi/`、project resource root は `conductor.pi.projectDir` → `<repoRoot>/.ensemble/pi/` の順で解決します。config の相対パスはリポジトリ root 基準、`~` はユーザ home 基準です。

```yaml
conductor:
  backend: pi
  pi:
    agentDir: ~/.ensemble/pi
    projectDir: .ensemble/pi
```

Pi conductor は各 root の `settings.json`、`auth.json`、`models.json`、`extensions/`、`skills/`、`prompts/`、`themes/` を user → project の順で読みます。project の設定が同じ provider/resource を上書きします。headless conductor の対応範囲は [config.md の Pi resource root](config.md#pi-resource-root) を参照してください。

### Skills（Pi 標準）

profile の `conductor.piSkills`（省略時は有効）が `true` のとき、conductor は Pi の `DefaultResourceLoader` で skill を索引します。system prompt には skill 名・説明・ファイルパスのカタログが載り、本文は built-in の `read` または `/skill:<name>` で読みます。`conductor.builtinTools: false` のときは `read` が無く、カタログが載らない場合があるため、skill を使う Pi conductor では built-in tools を有効にするか、別途 skill 索引手段を用意してください。

`.ensemble/pi/skills/` に置いた skill は Pi discovery に渡されます。リポジトリ直下の `.agents/skills/` や、Claude / Cursor / Codex の skill ディレクトリは Pi 標準どおり `settings.json` の `skills` 配列で追加します（例: `"skills": [".claude/skills", ".cursor/skills"]`）。詳細は [Pi skills ドキュメント](https://github.com/earendil-works/pi/blob/v1.0.2/packages/coding-agent/docs/skills.md) を参照してください。

### 2. provider と model を選ぶ

通常は Pi の resource root のどちらかに `settings.json` を置き、provider と model を指定します。`conductor.model` または `ensemble issue --model` で provider/model を明示する場合は、model 選択だけのために `settings.json` を置く必要はありません。

```json
{
  "defaultProvider": "<provider-id>",
  "defaultModel": "<model-id>"
}
```

`defaultModel` に `<provider-id>/<model-id>` を指定することもできます。選択中の model を `conductor.model`、`ensemble issue --model <provider>/<model>`、または `runConductorSession({ modelId })` で明示した場合は、それが Pi の設定より優先されます。provider を省略しても、model id から一意に決まる場合は推測されます。CLI と直接 API の優先順は [設定値リファレンス](settings.md#解決パターン)を参照してください。

provider を確実に指定して認証する場合は、次のようにします。

```bash
ensemble auth login --provider <provider-id>
```

`--provider` を省略した場合は、Pi の `defaultProvider`、選択された model、または `--model-id` から provider を解決します。`auth login` / `logout` / `status` の provider 解決は同じです。

### 3. 認証を取得する

Pi のログインは Cursor のような全体ログインではなく **provider 単位**です。

OpenAI provider (`openai`) は OAuth と API key の両方に対応します。`ensemble setup` では方式を選び、API key を選んだ場合は TTY の非表示 prompt から user `auth.json` に保存します。`ensemble auth login --provider openai` は従来どおり OAuth を開始します。OpenAI API key を `auth login` で保存する場合は、TTY なら `--api-key-prompt`、非 TTY なら `--api-key-stdin` を明示してください。

#### API key provider

```bash
# API-key-only provider
ensemble auth login --provider <provider-id>

# OAuth も使える provider（例: OpenAI）で API key を選ぶ
ensemble auth login --provider openai --api-key-prompt
```

TTY の secret prompt に API key を入力します。prompt と入力待ちは stderr に出力され、入力値は表示されません。成功した credential は user resource root の `auth.json`（既定では `~/.ensemble/pi/auth.json`）へ保存されます。`conductor.pi.agentDir` を指定している場合はその配下です。project の `auth.json` はこのコマンドでは書き換えません。

OAuth と API key の両方に対応する provider で API key を選ぶには、TTY から次を実行します。

```bash
ensemble auth login --provider openai --api-key-prompt
```

非 TTY では、秘密値を argv に含めず標準入力から渡せます。

```bash
secret-manager read <secret-name> | ensemble auth login --provider openai --api-key-stdin
```

`--api-key-stdin` は非 TTY 専用です。値は表示・記録されず、成功後も user resource root の `auth.json` だけが更新されます。project `auth.json` や project Pi settings は変更しません。provider 固有の環境変数を設定した場合は request 時に利用できますが、`auth.json` には保存されません。API key を保存せず環境変数で使う場合や Pi resource から解決する場合は、下記の認証解決順を確認してください。

#### 保存先の保護

setup と login / logout は、project の `.ensemble/` 全体と設定された project Pi root を書き込み保護します。両 root 配下の file / directory symlink も調べ、リンク先が root の外でも、その target を project 層の一部として扱います。user 側の書き込み先が project path、または project symlink から path として辿れる target と重なる場合は処理を拒否します。Pi user-root lock の sidecar path も同じ境界で検査し、project-owned path を指す symlink や、大文字・小文字だけ異なる別名があれば lock を作成しません。project 層と共有していない外部 user symlink は利用でき、リンクを保ったまま実体を更新します。project root を検査できない場合も、安全を確認できないため書き込みを拒否します。case-insensitive volume では大文字・小文字だけ異なる path も同じ project path として扱い、volume の規則を判定できない場合は書き込みを拒否します。既存の hard link は書き込み前に user 側を独立した file に置き換え、project 側の内容を保ちます。OAuth が device ID を user `settings.json` に保存する場合も、保存前にこの project 境界を確認します。

この境界は path と symlink をたどって照合します。bind mount など別の path 名で同じ file system object を参照する別名や、検査の直後に別 process が symlink を差し替える競合までは保護を保証できません。通常の hard link は setup の atomic replacement、login / logout 前の user file 分離で project 側への変更を防ぎます。

POSIX では setup が user config / Pi settings を、API key login が user auth file を mode `0600` で作成・更新します。Windows では Node.js の `fs` mode で owner / group / others を区別できず、この実装は Windows ACL を設定・検証しません。`settings.json` は `apiKey` / `apiKeys` を保持できるため、`0600` を Windows の owner-only 保証として扱わないでください。

setup は既存 `settings.json` を同じ directory の一時 file に書いてから置き換えます。Windows では一時 file が directory の既定 ACL を受け継ぐため、置換後に元 file 固有の ACL が維持される保証はありません。OAuth device ID の保存は、既存の single-link `settings.json` を直接更新するため、その file の ACL を保ちます。file がまだ無い場合は新規作成となり、directory の既定 ACL を受け継ぎます。hardlink を分離するときは file を置き換えるため、directory の既定 ACL が使われます。

auth file も新規作成・置換時は保存先 directory の既定 ACL を受け継ぎます。既存の single-link auth file を OAuth login / logout で更新するときは file を置き換えないため、その ACL を保ちます。実装は Windows ACL を設定・検証しません。`settings.json` / `auth.json` 自体と、置換時の継承元になる保存先 directory の両方で、意図した利用者だけに読取権限を与えてください。Windows の ACL 継承・置換動作は実機で検証していません（[Node.js v22 `fs` の file modes](https://nodejs.org/download/release/v22.23.3/docs/api/fs.html#file-modes)、[Windows file security](https://learn.microsoft.com/en-us/windows/win32/fileio/file-security-and-access-rights)、[MoveFileExW の置換動作](https://learn.microsoft.com/en-us/windows/win32/api/winbase/nf-winbase-movefileexw)、[Node.js v22 の Windows `rename` 実装](https://github.com/nodejs/node/blob/v22.23.3/deps/uv/src/win/fs.c#L2109-L2115)）。

#### OAuth provider

```bash
ensemble auth login --provider <oauth-provider-id>
```

OAuth login も TTY が必要です。Pi 1.x の `ModelRuntime.login` が認証を行い、URL、device code、進捗、追加 prompt は stderr に出します。SSH では表示された URL / device code を別のブラウザで使えます。OAuth credential は user runtime に保存され、conductor の各 request で runtime が必要に応じて refresh します。

OpenAI provider（`openai`）の ChatGPT OAuth は installation ごとの UUID（device ID）を必要とします。login 時に user resource root の `settings.json` から `deviceId` を取得し、未作成なら生成して保存します。同じ `conductor.pi.agentDir` を使う ensemble の Pi setup と OpenAI OAuth login による user `settings.json` の read-modify-write は、同じ root lock に参加する通常稼働中の CLI process 間で直列化します。OAuth runtime には保存済みの ID を渡し、login をやり直す場合も同じ ID が使われます。agentDir を変えると別の installation として ID が作られます。値を手で設定する必要はありません。Pi CLI など ensemble の同期に参加しない別アプリが、同時に同じ `settings.json` の device ID を変更する競合までは対象に含みません。

この lock は `proper-lockfile` の lease を使い、既定ではおよそ5秒ごとに更新し、10秒更新されない lock を stale として回収します。process の異常終了後は stale lock が回収されますが、process の停止や filesystem の遅延が stale threshold を越える状況では、稼働中の lock が回収されて処理が重なる可能性があります。通常の同時 login は child process regression で検証していますが、crash・長時間停止時の競合までは保証していません。

ChatGPT OAuth を使わない場合は、次の方法があります。

| 方法 | 手順 |
|------|------|
| OpenAI API key | `ensemble setup` で API key を選ぶと user `auth.json` に保存します。`ensemble auth login --provider openai` は既定で OAuth login を選びます。API key を保存する場合は TTY で `--api-key-prompt`、非 TTY で `--api-key-stdin` を指定します。`OPENAI_API_KEY` は request 時に利用できますが、保存はしません。OpenAI 公式の model ID を選びます。 |
| Pi CLI で先に OAuth login | Pi CLI の agent directory を ensemble と同じ `conductor.pi.agentDir` に合わせ、Pi CLI の `/login` から `openai` provider に login します。credential は共有の `auth.json` に保存されるため、ensemble はその credential で request を送れます。 |
| LiteLLM | 既存の `models.json` にある LiteLLM provider を引き続き使います。ChatGPT OAuth の device ID は不要です。 |

Pi CLI の既定 agent directory は `~/.pi/agent`、ensemble の既定 user root は `~/.ensemble/pi` です。共有するには Pi CLI 起動時に directory を指定します。

```bash
PI_CODING_AGENT_DIR="$HOME/.ensemble/pi" pi
```

`conductor.pi.agentDir` を変更している場合は、その値と同じ directory を `PI_CODING_AGENT_DIR` に指定してください。

project 層の `auth.json` にある OAuth entry は refresh 対象になりません。project の明示的な OAuth credential は実行時に拒否されるため、project 側の stale entry を除去または置き換えたうえで、`ensemble auth login --provider <oauth-provider-id>` を user 層に実行してください。login は project `auth.json` を上書きしません。

### 4. 状態と model を確認する

```bash
ensemble auth status
ensemble models list
ensemble models list --provider <provider-id>
```

`auth status` は Pi の auth file の場所、provider ごとの configured 状態、credential の source を表示します。auth entry の型が分かる場合は `mode` も表示し、user `auth.json` の保存 API key は `mode=api_key; source=stored` となります。`api_key_stored` は認証 taxonomy の識別子で、status の `mode` には使いません。既存 `source` は出所を示す値として維持します。API key、token、環境変数の値は表示しません。`source` は粗い分類で、OAuth login の browser/manual 経路や、一部の `!command` を正確に示すものではありません。

Pi 1.2.0 の `AuthStatus.source?` は `stored` / `runtime` / `environment` / `fallback` / `models_json_key` / `models_json_command` の union です（[型定義](https://github.com/earendil-works/pi/blob/v1.2.0/packages/coding-agent/src/core/provider-composer.ts#L103-L107)）。一方、Ensemble の公開 `PiProviderAuthStatus.source?` は `string` のままで、Pi SDK にない `project_oauth_unsupported` / `project_stored` / `settings_json` などの値も返します（[Ensemble の型定義](../packages/core/src/conductor/conductor-pi-auth.ts#L39-L44)）。次の表は両方の source をまとめたものです。

| `source` | 出力元 | 現行表示が示すもの |
|----------|--------|-------------------|
| `runtime` | Pi 1.2.0 | Pi runtime override の登録を示します。headless path では通常、user → project に merge した `settings.json.apiKeys[provider]` の値です。値が非空なら user `auth.json` より先に使われます。空文字の例外は下記を参照してください |
| `stored` | Pi 1.2.0 | runtime override が登録されていない場合に使われる user `auth.json` の credential。既知の API-key / OAuth entry は `mode` でも区別します |
| `project_oauth_unsupported` | Ensemble | project OAuth entry。`configured=false` となり、実行時に拒否される |
| `project_stored` | Ensemble | project `auth.json` の API key / `!command` entry。request では user 層より先です。既知の API-key / command entry は `mode` でも区別します |
| `fallback` | Pi 1.2.0 | Pi status が、現行 headless path で `ModelRuntime.registerProvider` に渡した `models.json` provider の通常の `apiKey` を報告した値。環境変数参照は登録前に展開されます。この SDK source 名は scalar settings fallback を指しません |
| `models_json_command` | Pi 1.2.0 | Pi status が provider 設定の `apiKey: "!command"` を `ModelRuntime.registerProvider` に渡したことを示す値。現行 headless path では通常 `models.json` の command です |
| `environment` | Pi 1.2.0 / Ensemble | Pi の provider auth check、または Ensemble の provider-env fallback。Pi の `label` は AWS profile / ADC など ambient auth を示す場合もあり、環境変数名とは限りません |
| `settings_json` | Ensemble | Pi `ModelRuntime` が configured source を返さず、Ensemble が settings 候補を fallback として検出した場合。scalar `apiKey` が先、なければ `apiKeys[provider]` を選びます。この source だけでは key / command や user / project の別を区別できません |
| `models_json_key` | Pi 1.2.0 / Ensemble | Pi SDK の union に含まれる値で、Ensemble も `models.json` 候補の直接 fallback に使います。直接 fallback では通常 key と `!command` を区別しません。通常の headless `registerProvider` 経路では、通常 key は `fallback`、command は `models_json_command` と表示されます |

現行の status lookup は、project `auth.json` の確認後に Pi `ModelRuntime` の status（runtime > stored > provider 設定 > provider auth check）を見ます。Pi status が configured source を返さなければ、Ensemble が settings (`settings_json`)、models (`models_json_key`)、provider 環境変数 (`environment`) の順に確認します。Pi の `source=environment` は process 環境変数だけでなく ambient auth を表す場合があるため、taxonomy の `mode=environment` と同じ意味だとは限りません。

空の `settings.json.apiKeys[provider]` は現行 status と request で扱いが異なります。Ensemble は空文字も `ModelRuntime.setRuntimeApiKey()` に登録し、Pi の status は Map に登録があることを見て `source=runtime` を返します（[登録処理](../packages/core/src/conductor/conductor-pi-auth.ts#L813-L820)、[Pi の status lookup](https://github.com/earendil-works/pi/blob/v1.2.0/packages/coding-agent/src/core/model-runtime.ts#L612-L621)）。一方、Pi の `RuntimeCredentials.read()` は override の値を truthy 判定するため、空文字は API key として使わず、保存 credential の読取りへ進みます（[`read()`](https://github.com/earendil-works/pi/blob/v1.2.0/packages/coding-agent/src/core/runtime-credentials.ts#L18-L25)）。そのため空 entry と user `auth.json` credential が共存すると、status は `runtime` でも、request resolver は保存 credential の読取りへ進みます。Pi がその credential を利用できれば request で使われます。保存 credential がなくても Pi は provider 設定や provider auth / 環境・ambient auth を確認しますが、それらから key を得られず、scalar `apiKey` もない場合は、現行 Ensemble resolver が選択された空の `apiKeys` 値を fallback として返すことがあります。この場合、後続の `models.json` / provider-env fallback まで進むとは限らず、request は失敗し得ます（[Ensemble の request resolver](../packages/core/src/conductor/conductor-pi-auth.ts#L254-L315)）。ここでの `runtime` は request で実際に使われる key の確認ではありません。

request の解決順は status lookup と同じではありません。非 command の `settings.json.apiKeys[provider]` は runtime override として登録され、値が非空なら user `auth.json` より先に request で使われます。一方、scalar `settings.json.apiKey` の通常 key は runtime override ではなく、Pi が key を返さなかった場合の Ensemble fallback です。scalar `apiKey` が `!command` なら request 時に provider 設定へ登録されます。request 時に登録する settings command は status で実行も登録もしません。user `auth.json` や有効な非空 runtime override がなければ、その command が `models.json` provider 設定や provider auth より先に使われても、status はそれら下位 source を表示することがあります。merged settings の provenance も status に残りません。したがって `configured=true` や `source` は request 成功の保証でも、実効 credential の常時特定でもありません。

`models list` は Pi の `ModelRegistry` と解決済み resource を使い、認証済み provider の model だけを表示します。対象 provider を `--provider` で絞れます。認証済み model が無い場合は Pi 向けの login / auth file / 環境変数の案内を含むエラーになります。

### OpenAI 互換 provider の catalog を比較・追加する

LiteLLM など、`models.json` に OpenAI 互換 endpoint として設定した Pi provider は、明示的に `models remote`、`diff`、`add` を実行して `/v1/models` catalog を利用できます。provider には `api: "openai-completions"` など Pi の OpenAI 互換 `api` と `baseUrl` が必要です。`baseUrl` は Pi の API base URL（通常は末尾が `/v1`）を指定してください。末尾が `/v1` なら `/models`、それ以外なら `/v1/models` を追加して取得します。

```bash
# リモート catalog の ID 一覧
ensemble models remote --provider litellm

# API only / JSON only / 両方にある ID を表示（models.json は変更しない）
ensemble models diff --provider litellm

# API にある ID を明示して user models.json に追加
ensemble models add gpt-6-luna gpt-6-sol --provider litellm

# project models.json に追加
ensemble models add gpt-6-luna --provider litellm --target project

# 同じ比較結果を機械処理する
ensemble models diff --provider litellm --json
```

`add` は追加したい ID を 1 件以上明示します。複数 ID を指定した場合はすべてが API に存在することを確認してから書き込み、不明な ID があれば何も追加しません。catalog の全件を自動追加する機能ではありません。書込先は省略時 user で、project へ書く場合は `--target project` を指定します。project は `conductor.pi.projectDir`（既定 `<repoRoot>/.ensemble/pi`）、user は `conductor.pi.agentDir`（既定 `~/.ensemble/pi`）にある `models.json` です。

既存 ID は既定で変更せず、`--refresh-metadata` を指定した場合だけ、API から取得できた metadata を field ごとに更新します。LiteLLM の `supported_reasoning_efforts: null` または省略は不明として map を作らず、既存の手編集値も残します。`[]` は既知の空集合なので `thinkingLevelMap` の全 level を `null` にしますが、それだけでは `reasoning: false` を設定しません。`supports_reasoning: false` は schema default と明示値を response 上で区別できないため、否定の根拠に使いません。`supports_reasoning: true` は `reasoning: true` に反映し、effort list が不明なら既存の level map は保持します。`contextWindow`、model 名、`maxTokens`、`cost`、header など既存の項目は refresh でも保持します。

`models add` と非推奨の `models sync` が同期する field は次のとおりです。実装では endpoint と provider ごとに source を登録し、Pi field・追加時の扱い・refresh 対象を一つの field registry で管理します。

| provider / source | API field | Pi `models.json` | 扱い |
|---|---|---|---|
| OpenAI 互換 `GET /v1/models` | `data[].id` | `id` | 明示選択した ID を保存。LiteLLM group metadata の join key にも使う |
| OpenAI 互換 `GET /v1/models` | `data[].max_input_tokens`（provider が返す場合） | `contextWindow` | 正の安全な整数だけ。新規追加時に設定し、既存行の refresh では更新しない |
| Magpie `GET /v1/models` 拡張 | `reasoning` | `reasoning` | boolean を保存。省略時は effort 一覧から推定 |
| Magpie `GET /v1/models` 拡張 | `supported_reasoning_levels`（`{ effort }[]`）または `reasoning_levels`（`string[]`） | `thinkingLevelMap` | Pi native の `off` / `minimal` / `low` / `medium` / `high` / `xhigh` / `max` を完全一致で対応。provider 値 `none` は `off` に対応し、未対応 level は `null` |
| LiteLLM (`provider: litellm`) `GET /model_group/info` | `data[].model_group` | — | `/v1/models` の `id` と完全一致する行だけを結合し、追加対象 ID は増やさない。reasoning fieldを含む応答で一致しない追加対象があれば、理由を推定せず warning を出す |
| LiteLLM `GET /model_group/info` | `supports_reasoning: true` | `reasoning: true` | `false` は schema default と明示値を区別できないため同期しない。effort list に `off` / `none` 以外の値があれば `reasoning: true` の根拠にもする |
| LiteLLM `GET /model_group/info` | `supported_reasoning_efforts`（`string[]` / `null`） | `thinkingLevelMap` | `null` / 省略時は不明として map を作らない。`[]` は全 level を `null` にする。値がある場合は Pi native level に完全一致で写し、`none` は `off`、一覧にない level は `null` |

### LiteLLM の reasoning metadata

以下の LiteLLM source link は、tag `v1.108.3` が参照する commit [`b7d579f`](https://github.com/BerriAI/litellm/commit/b7d579fab2818968322ef96e5b8e98dc8178fafc) に固定しています。引用範囲はこの commit の file blob と照合しています。

LiteLLM v1.108.3 の通常 [`GET /v1/models` route](https://github.com/BerriAI/litellm/blob/b7d579fab2818968322ef96e5b8e98dc8178fafc/litellm/proxy/proxy_server.py#L11835-L12098) は OpenAI 互換の `{ object: "list", data: [...] }` を返します。row schema の [`ModelInfoResponse`](https://github.com/BerriAI/litellm/blob/b7d579fab2818968322ef96e5b8e98dc8178fafc/litellm/types/proxy/model_listing.py#L12-L25) に reasoning field はありません。`client_version` が指定された場合の Codex 固有 response shape も同じ route に記載されています。

reasoning metadata は [`GET /model_group/info` route](https://github.com/BerriAI/litellm/blob/b7d579fab2818968322ef96e5b8e98dc8178fafc/litellm/proxy/proxy_server.py#L17254-L17481) から取得します。route の group builder ([`get_model_group_info`](https://github.com/BerriAI/litellm/blob/b7d579fab2818968322ef96e5b8e98dc8178fafc/litellm/proxy/proxy_server.py#L17217-L17248)) は `ModelGroupInfoProxy.model_validate(_model_group_info.model_dump())` で group object を組み立て、`data[]` で返します。response model [`ModelGroupInfoProxy`](https://github.com/BerriAI/litellm/blob/b7d579fab2818968322ef96e5b8e98dc8178fafc/litellm/types/proxy/management_endpoints/model_management_endpoints.py#L11-L15) は [`ModelGroupInfo` schema](https://github.com/BerriAI/litellm/blob/b7d579fab2818968322ef96e5b8e98dc8178fafc/litellm/types/router.py#L925-L959) を継承します。schema 上、`supports_reasoning` は default `false`、`supported_reasoning_efforts` は nullable な tuple です。initializer は `supports_reasoning: null` も `false` に正規化します。

Router は deployment の `supports_reasoning: true` を見つけたときだけ group field を `true` にします。group-level の集約は [`_set_model_group_info`](https://github.com/BerriAI/litellm/blob/b7d579fab2818968322ef96e5b8e98dc8178fafc/litellm/router.py#L11704-L11968) が行います。response には「明示設定か default か」の出所情報が残りません。そのため `supports_reasoning: false` だけでは unsupported を確定できません。importer は `true` を肯定の根拠とし、`false` は `reasoning: false` に同期しません。この区別を API から復元できない点は LiteLLM v1.108.3 の contract 上の制約です。

`supported_reasoning_efforts` は deployment 間の共通集合です。上流 resolver の [`resolve_supported_reasoning_efforts`](https://github.com/BerriAI/litellm/blob/b7d579fab2818968322ef96e5b8e98dc8178fafc/litellm/router_utils/reasoning_effort_capability.py#L153-L195) では、対応 effort が分かっていて空なら `[]`、effort 情報を確定できなければ `null` になります。したがって `false` と `null` の組合せは `reasoning` / `thinkingLevelMap` のいずれも更新せず、`false` と `[]` の組合せは map だけを全 `null` にします。effort list に `off` / `none` 以外の値があれば、`supports_reasoning` が schema default の `false` でも、その list を positive signal として `reasoning: true` を同期します。

LiteLLM v1.108.3 では、`/v1/models` は caller の key/team alias に応じて公開 ID を組み立て、内部の metadata lookup ID とは別の `data[].id` を返す場合があります。route は [`caller_alias_maps`](https://github.com/BerriAI/litellm/blob/b7d579fab2818968322ef96e5b8e98dc8178fafc/litellm/proxy/common_utils/model_listing_utils.py#L207-L217) と [`alias_listing_entries`](https://github.com/BerriAI/litellm/blob/b7d579fab2818968322ef96e5b8e98dc8178fafc/litellm/proxy/common_utils/model_listing_utils.py#L320-L342) を使い、公開 ID と metadata lookup ID を分けます。その response row schema には canonical group への参照がありません（[`ModelInfoResponse`](https://github.com/BerriAI/litellm/blob/b7d579fab2818968322ef96e5b8e98dc8178fafc/litellm/types/proxy/model_listing.py#L12-L25)）。

`/model_group/info` の `data[]` は `model_group` などを持つ group object を返します。route は [`TeamModelNameTranslator`](https://github.com/BerriAI/litellm/blob/b7d579fab2818968322ef96e5b8e98dc8178fafc/litellm/proxy/common_utils/model_listing_utils.py#L383-L436) で group の公開名を導出し、listing callback の非表示判定にだけ使います（[response filter](https://github.com/BerriAI/litellm/blob/b7d579fab2818968322ef96e5b8e98dc8178fafc/litellm/proxy/proxy_server.py#L17467-L17481)）。公開名を response の独立した field として返すわけではありません。response に caller alias の対応表も含まれないため、両 endpoint は `id` と `model_group` の完全一致で結合します。一致しない ID については、metadata endpoint が reasoning field を返している場合に `models add` が warning を stderr と JSON に出し、reasoning metadata を同期しません。context など `/v1/models` 由来の情報は引き続き追加します。候補が 1 件だけの場合や token limit が一致する場合も、alias 先は推測しません。alias 用の reasoning 設定が必要なら、`models.json` に手動で記述してください。

`model_group` と `/v1/models` の `id` を結合しても、`/v1/models` にないgroupは追加しません。必要なreasoning fieldが `/model_group/info` にあるため、Codex 専用catalogを読む必要はありません。

`models add` / `models sync` は provider ID が `litellm` の場合に限り、既存の fetch と認証 header を使って `/model_group/info` も GET します。`baseUrl` が `/v1` で終わる場合は、その suffix を外した host / path prefix に endpoint を付けます。新しい API client は不要です。追加 endpoint の取得失敗・不正な response は warning に記録し、従来の `/v1/models` による追加処理を続けます。この場合 reasoning metadata は取り込みません。`models remote` と `models diff` は ID 比較だけを行うため、この追加 endpoint は呼びません。

LiteLLM の `supported_reasoning_efforts` は Pi の `thinkingLevelMap` に同期します。以下は現行実装の同期対象外です。

| source | field | 同期しない理由 |
|---|---|---|
| LiteLLM `GET /model_group/info` | `supports_fast_mode` | Pi の `models.json` に対応する fast-mode field がない |
| LiteLLM `GET /model_group/info` | `input_cost_per_token` / `output_cost_per_token` | Pi の `cost` に必要な cache read / write 単価がこの response にない。欠損を 0 として書くと cost estimate を誤らせる |
| LiteLLM `GET /model_group/info` | `max_output_tokens` | Pi の `maxTokens` に自動同期しない。既存の出力上限設定を維持する |
| LiteLLM `GET /model_group/info` / provider catalog（値がある場合） | `providers`、`mode`、`name` / `display_name`、`description`、modalities、その他 capability flags | conductor の reasoning validation に使わず、Pi field への写像も定めていない |
| — | 独立した efficiency metric | この同期では対応する source field と Pi field の mapping を定義していない |
| OpenAI 互換 `GET /v1/models` | `max_output_tokens`、`owned_by`、`created` | 出力上限や表示 metadata の自動変更はこの同期対象外。既存 Pi 設定を保持する |
| Codex 用 `GET /v1/models?client_version=...` | `models[]` | `/model_group/info` が必要な LiteLLM reasoning effort を提供するため、Codex 固有 catalog を別途取り込まない |

Magpie の `/v1/models` reasoning 拡張の shape は、[統合ガイド](https://github.com/yetone/magpie/blob/main/docs/integrating.md)、[`GET /v1/models` route](https://github.com/yetone/magpie/blob/main/internal/gateway/gateway.go#L914-L916)、[row の metadata fields](https://github.com/yetone/magpie/blob/main/internal/gateway/gateway.go#L1263-L1284)、[response envelope](https://github.com/yetone/magpie/blob/main/internal/gateway/gateway.go#L1645-L1649)、[reasoning catalog test](https://github.com/yetone/magpie/blob/main/internal/gateway/gateway_test.go#L987-L1065)で確認できます。reasoning field を返さない provider は従来どおり ID と `max_input_tokens` 由来の `contextWindow` だけを同期します。

従来の `models sync` は非推奨ですが、互換性のため少なくとも 1 リリースは利用できます。比較には `models diff`、追加には `models add` を使ってください。複数 ID を追加する `sync --add first --add second` は `add first second` に移行できます。どちらも全 ID を検証してから書き込み、書込先の省略時は user です。

機械処理で `sync --json` から `diff --json` に移行する場合は、コマンドだけでなく出力の読み取り方も変更してください。

| フィールド | `sync --json` | `diff --json` |
|---|---|---|
| `provider` | provider ID の文字列 | 同じ |
| `apiOnly` | `{ id, maxInputTokens?, reasoning?, thinkingLevelMap? }` の配列 | ID の文字列配列 |
| `jsonOnly` / `shared` | ID の文字列配列 | 同じ |
| `added` / `skipped` | 追加・スキップした ID の文字列配列 | なし |
| `refreshed` | metadata を更新した ID の文字列配列 | なし |
| `metadataWarnings` | 補助 metadata endpoint が使えなかった場合のみ | なし |
| `targetPath` | 追加して書き込んだ場合のみ、書込先の文字列 | なし |

例えば `sync` の `.apiOnly[].id` は、`diff` では `.apiOnly[]` です。`maxInputTokens` は API の `max_input_tokens` が正の安全な整数の場合に `sync` の `apiOnly` に含まれますが、`diff` には含まれません。互換形やこの値が必要なスクリプトは、非推奨期間中は引き続き `sync --json` を使えます。非推奨警告は stderr に出力されます。追加結果を取得する場合は `add --json` の `added` / `skipped`、`--refresh-metadata` による更新結果がある場合は `refreshed`、書込み時のみ含まれる `targetPath` を利用してください。

`sync --add ... --json` の `apiOnly` / `jsonOnly` / `shared` は、**追加前**の models.json と API を比較した結果です。`added` / `skipped` はその比較後に行う追加の結果です。新コマンドで追加前の差分が必要な場合は、`diff --json` を `add` より先に実行してください。追加後に `diff` を実行すると、追加された ID は通常 `apiOnly` から `shared` に移るため、旧 `sync` が返した比較結果とは異なります。

ただし `diff` と `add` は別々に catalog を取得するため、間に catalog や models.json が変わることがあります。旧 `sync` の一度の取得・比較・追加と同じ snapshot になる保証はありません。旧 JSON をそのまま必要とする場合は、非推奨期間中の `sync --add ... --json` を使ってください。

user の `models.json` に追加しても、project の同じ provider に `models` 配列がある場合は Pi の project 優先により user 配列が隠れます。その場合はコマンドが書込前に停止するので、`--target project` を選んでください。

これらのコマンドは Pi provider の `baseUrl`、`apiKey`（環境変数参照や `!command` を含む）、`authHeader` と既存の Pi credential 解決を使って catalog を取得します。認証情報、header、provider の応答本文は出力しません。ネットワーク接続は `models remote` / `diff` / `add` / 旧 `sync` の明示実行時だけで、conductor の通常の `ModelRuntime` は引き続き `allowModelNetwork: false` です。

API が `max_input_tokens` を返す場合は、追加する Pi model の `contextWindow` にその整数値を設定します。Pi の `contextWindow` はモデルの入力コンテキスト上限として使われます。この値は provider が返した上限の取り込みであり、Pi の出力上限 `maxTokens` は設定しません。endpoint 側の値が不正または欠落していれば `contextWindow` は省略され、Pi の既定値が使われます。

追加内容は、次回の `ensemble models list --provider <id>` で読み直されます。新しい conductor session でも create / resume 時に `models.json` が読み込まれます。実行中 session は hot reload しません。

### 5. Issue を実行する

```bash
ensemble issue https://github.com/OWNER/REPOSITORY/issues/123
```

Pi backend の選択後も、Issue、worker、worktree、PR の主経路は Cursor backend と同じです。

## 認証の解決順

request 時の解決は、project `auth.json`、Pi `ModelRuntime`、最後の Ensemble fallback に分かれます。`settings.json.apiKeys[provider]` と scalar `settings.json.apiKey` は別経路です。

1. 明示的な内部 API key override があればそれを使います。この引数は利用者向け設定項目ではありません。
2. user / project resource root が別なら、project `auth.json` の provider entry を先に確認します。API key / command は user 層より先に使います。project OAuth entry は refresh できないため拒否し、user credential や環境変数へ fallback しません。
3. project entry がなければ Pi `ModelRuntime.getAuth()` で解決します。
   - user → project に merge した `settings.json.apiKeys[provider]` の非 command 文字列は runtime API key として登録されます。値が非空なら Pi 1.2.0 の `RuntimeCredentials.read()` が保存 credential より先に返すため、同じ provider の user `auth.json` に別の key / OAuth があっても runtime override が有効です。両 settings root に値がある場合は project 側が merge 結果に残ります。空文字も登録はされますが request 読取りでは使われず、status だけが `runtime` となり得ます（上記参照）。
   - request に使える runtime override がなければ、Pi は user `auth.json` の保存 credential（API key または OAuth）を provider 設定より先に解決します。
   - 保存 credential がなければ provider 設定を解決します。`settings.json` の候補は scalar `apiKey` が先で、なければ `apiKeys[provider]` です。選ばれた値が `!command` の場合は request 時に provider 設定へ登録され、`models.json` の provider key / command を上書きします。ただし、その command は runtime override と保存済み user credential より後に解決されます。settings command がない場合は、登録済み `models.json` provider の設定が使われます。Pi の provider 固有環境変数や AWS profile / ADC など ambient auth は、provider 設定に key がない場合の runtime resolver 経路です。`models.json` の `$NAME` / `${NAME}` は Ensemble が provider 登録前に展開します。
4. `ModelRuntime.getAuth()` が API key を返さないか error になった場合、選ばれた settings / models 候補に `!command` があれば command error を返し、下位 key へ進みません。command 候補がなければ Ensemble が追加 fallback を行います。command でない settings 候補（scalar `settings.json.apiKey` が先で、なければ `apiKeys[provider]`）> `models.json` provider `apiKey` > provider 環境変数の順です。非空の非 command `apiKeys[provider]` は通常 runtime override として先に解決されるので、この fallback で選ばれるのは主に scalar key です。空の `apiKeys[provider]` は現行 fallback で定義済み候補として返され、後続候補を妨げることがあります（上記参照）。

したがって scalar `settings.json.apiKey` は最優先の key ではありません。Pi が provider 設定や環境・ambient auth から key を返せば、scalar settings key は使われません。scalar と `apiKeys[provider]` の順序は settings 候補内の選択規則であり、非 command の `apiKeys[provider]` runtime override の優先順位を下げるものではありません。Ensemble は `ModelRuntime.getAuth()` の error を捕捉して追加 fallback へ進む場合もあります。status の source はこの request-time fallback の成否までは示しません。

Pi 1.2.0 の根拠は [`AuthStatus.source` の型](https://github.com/earendil-works/pi/blob/v1.2.0/packages/coding-agent/src/core/provider-composer.ts#L103-L107)、[`RuntimeCredentials.read()`](https://github.com/earendil-works/pi/blob/v1.2.0/packages/coding-agent/src/core/runtime-credentials.ts#L18-L25)、[`ModelRuntime.getProviderAuthStatus()`](https://github.com/earendil-works/pi/blob/v1.2.0/packages/coding-agent/src/core/model-runtime.ts#L612-L621)、[`resolveProviderAuth()`](https://github.com/earendil-works/pi/blob/v1.2.0/packages/ai/src/auth/resolve.ts#L28-L93)、provider 設定と source mapping の [`provider-composer.ts`](https://github.com/earendil-works/pi/blob/v1.2.0/packages/coding-agent/src/core/provider-composer.ts#L685-L699) です。Ensemble 側の status、provider 登録と fallback は [`conductor-pi-auth.ts`](../packages/core/src/conductor/conductor-pi-auth.ts) にあります。

古い Pi API の説明で `AuthStorage` と呼ばれている user credential 層は、現在の Pi 1.x 経路では `ModelRuntime` が担います。利用者が意識する保存先と login の挙動は user `auth.json` です。`settings.json.apiKeys[provider]` の runtime override はその保存先に書き込まず、user login で置き換わりません。

`settings.json` / `models.json` の `apiKey` は環境変数参照（`$NAME` / `${NAME}`）や `!command` を含められます。project `auth.json` の API key entry にも command を指定できます。`!command` は Pi runtime が credential を解決するときに conductor process の shell / OS user / 環境で実行します。これは LLM が呼ぶ tool ではなく、worker ACP の permission 処理や harness の追加 sandbox は通りません。したがって project の Pi resource を含む設定ファイル自体が実行可能な入力です。未確認の repository から読み込んだ project resource では command を有効にせず、設定と command の両方を確認してください。

`auth status` は `!command` を実行しません。また、`ensemble auth login` は command を登録しません。API key credential は user `auth.json` に保存されますが、有効な非空の `settings.json.apiKeys[provider]` runtime override があれば、保存 credential より優先されます。user login だけではこの override は置き換わらないため、実効 key を更新するには該当する user / project `settings.json` の値を確認してください。空文字は status で `runtime` と表示されても request では runtime override として使われず、保存 credential など下位 source の解決へ進みます（上記参照）。project `auth.json` の API key / command も user credential より先に選ばれるため、これを有効にしたまま user login しても effective credential は変わりません。OpenAI OAuth login では user `settings.json` の device ID も管理します。command の結果を含む認証値を repository に書かず、Pi resource や project 設定を commit する場合は値・command と `.ensemble/` の ignore 状態を確認してください。詳細は [config.md](config.md#pi-resource-root) を参照してください。

user `auth.json` の credential は CLI が生成・更新するものを使うのが基本です。project resource、`settings.json`、`models.json` に秘密値を置く場合もリポジトリへ commit せず、`.ensemble/` の ignore 方針とアクセス権を確認してください。

### `!command` とトークン取得の連続実行（LiteLLM / gcloud 等）

Pi conductor は **LLM リクエストの直前**で `apiKey` の `!command` を解決します。1 回の `conductor.send` の中でもツール往復により **同じコマンドが短時間に複数回**走ることがあります。`gcloud auth print-identity-token` のように **トークン発行 API に触れるコマンド**を直に `!` すると、OAuth 側のレート制限や一時的な失敗の原因になり得ます（[Issue #432](https://github.com/otolab/agents-ensemble/issues/432)）。

**ensemble harness は `!command` の自動ラップや TTL 設定を持ちません**（[ADR 0028](adr/0028-authentication-delegation-and-ensemble-auth.md) の移譲モデルのまま）。代わりに、**キャッシュ付きの認証ヘルパースクリプト**を `models.json` から呼び出してください。Codex worker の `[model_providers.*.auth]` + `refresh_interval_ms` と同型で、**毎 `getAuth` でスクリプトは起動するが、キャッシュ hit 時は内側の gcloud を実行しない**運用です。

Pi の `!command` は Node.js 実装の [scripts/pi/cached-auth.mjs](../scripts/pi/cached-auth.mjs) を使います。repository clone ではその絶対パスを指定してください。npm 配布版を使う場合、`@agents-ensemble/cli/scripts/pi/cached-auth.mjs` は package 内の相対パスなので、そのまま `!command` には渡せません。npm の install root から実ファイルの絶対パスを取得します。

```bash
# npm でグローバル install した場合（/ から実行し、repo の packageManager 設定を避ける）
realpath "$(cd / && npm root -g)/@agents-ensemble/cli/scripts/pi/cached-auth.mjs"

# 現在のプロジェクトに install した場合（consumer project root から実行）
realpath "./node_modules/@agents-ensemble/cli/scripts/pi/cached-auth.mjs"
```

出力された絶対パスを `models.json` の `apiKey` に使います。package subpath や `realpath` コマンド自体を `apiKey` に書くのではなく、出力された helper のパスを `!` の直後に指定してください。下の例の `/absolute/path/to/cached-auth.mjs` は、clone のパスまたは上記コマンドの出力に置き換えます。キャッシュファイルは既定で **`~/.ensemble/pi/cache/auth/`**（`600`。CWD や作業リポジトリに依存しない）に置きます。リポジトリ配下に置きたい場合は `--cache-dir` または `ENSEMBLE_PI_AUTH_CACHE_DIR` で上書きしてください。

```json
{
  "providers": {
    "litellm": {
      "baseUrl": "https://your-litellm.example/v1",
      "apiKey": "!/absolute/path/to/cached-auth.mjs --ttl-ms 300000 -- gcloud auth print-identity-token --account=you@example.com",
      "api": "openai-responses",
      "authHeader": true,
      "models": [{ "id": "your-model", "name": "your-model" }]
    }
  }
}
```

| 項目 | 説明 |
|------|------|
| `--ttl-ms` | この間隔より短い再実行では内側コマンドをスキップ（既定 `300000` = 5 分）。`ENSEMBLE_PI_AUTH_CACHE_TTL_MS` でも指定可。TTL を過ぎても JWT の `exp` が約 5 分より先なら再利用します。 |
| `--cache-dir` | キャッシュの置き場（**スコープの本体**）。既定は `~/.ensemble/pi/cache/auth` または `ENSEMBLE_PI_AUTH_CACHE_DIR`。 |
| `--cache-key` | 同一 `--cache-dir` 内で複数 credential を分けたいときだけ指定。未指定は `default`（内側コマンド行はキーに含めない）。 |
| `--` | 以降の argv を内側コマンドへ渡します。helper は shell を介さず、そのコマンドを直接起動します。 |
| JWT | stdout が JWT のとき、TTL に加え `exp` を Node.js で判定します。`python3` は不要です。 |
| クリア | 同じ `--cache-dir`（と `--cache-key`）で `--clear -- gcloud …`。`--clear` でも `--` と内側コマンドは必要です。`gcloud auth login` 後に実行するとよいです。 |

Worker（Codex）側は `~/.codex/config.toml` の `refresh_interval_ms` で同様の抑制ができます。Pi conductor だけ直 `!gcloud` のままにしないでください。

Node helper は既存の `default.token` / `default.meta` 形式を読み書きするため、#437 以降の bash 版が作ったキャッシュをそのまま使えます。`.meta` は引き続き取得時刻のミリ秒だけを保存します。miss / refresh / clear は cache-dir 内の `.lock.d` symlink で排他し、所有者の host・PID・process start identity を同じ cache-dir 内の専用 directory に記録します。Linux ではさらに owner と recovery process の PID namespace identity を `/proc/self/ns/pid` から記録し、確認側も一致する場合だけ PID を検査します。namespace identity が読めない、記録がない、または一致しない場合は owner を stale とみなさず、その lock を奪いません。Linux で現在の namespace identity を読めない場合、新しい lock の作成もエラーで止めます。同じ host・同じ PID namespace 上で owner の終了を確認できた lock は回収します。Linux の `/proc` が別 PID namespace から mount されている場合は `/proc/1/ns/pid` も照合し、現在の namespace と一致するときだけ `/proc/<pid>/stat` の field 22 `starttime`（clock ticks）を PID の開始 identity として使います。新形式で同じ PID が再利用され starttime が異なれば古い owner と区別して回収できます。namespace を照合できない、または starttime を読めない場合は、生きている PID を stale と判定せず lock を奪いません。生きた PID の identity が読めず保護された場合は timeout 後に失敗することがあります。終了済み PID は同じ namespace 上の `kill(pid, 0)` が `ESRCH` を返す場合に回収できます。更新前 helper が作成した秒粒度の Linux owner identity は、移行中に生きた lock を誤って奪わないよう従来の `ps` identity で照合します。旧形式は同秒の PID 再利用を区別できず live 扱いとなることがあり、その場合も lock を奪わず timeout まで待つ可能性があります。旧形式の照合ができない場合も stale とせず、生きた PID を保護します。

owner metadata を読んでいる間に別の helper が recovery directory と `.lock.d` symlink を片付けた場合は、symlink target を再確認して現在の lock state を読み直します。同じ target に owner metadata がない状態が続けば、短い bounded retry の後に fail-closed で停止します。固定された ownerless lock は自動削除しません。

macOS の process start identity は `ps -o lstart=` から得るため秒単位です。同じ秒のうちに PID が再利用され、start identity が一致して見える場合は owner を生存中として扱います。lock は奪われませんが、古い lock でも最大 60 秒の lock timeout まで待ってから失敗することがあります。より細かな時刻を返す Darwin native API はありますが、この単体 Node helper は native bridge / helper を含まず、そこからは取得しません。start identity を取得できない場合も PID の生存状態で保守的に判定し、終了済み PID が再利用されていれば同様に timeout まで待つ可能性があります。別 host や所有者を確認できない lock は奪わず、PID namespace が欠落・不一致の場合など判定不能な lock は待たずにエラーで停止します。

旧実装が作った owner metadata のない `.lock.d/` directory は、生きた旧 helper と異常終了後の残留物を安全に区別できないため自動回収しません。また、新しい owner metadata に Linux PID namespace identity がない旧形式 lock も Linux では回収しません。いずれもエラーが出た場合は、その cache-dir を使う helper がどの PID namespace からも動いていないことを確認してから、`.lock.d` を手動で削除してください。`.lock.d` が owner symlink の場合、参照先の `.lock-owner-*` directory は lock ではなく残骸になります。旧 bash 版の `.lock` file / directory には触れません。キャッシュディレクトリは `700`、token / meta は `600` で保存します。

#### bash 版からの移行

`scripts/pi/cached-auth.sh` は非推奨の互換 wrapper です。同じディレクトリに `cached-auth.mjs` がある場合だけ Node helper へ委譲します。Pi は Node.js が前提のため、bash 版単独の Node-less fallback は提供しません。

`~/.ensemble/pi/cached-auth.sh` を以前コピーして使っている場合、そのコピーは自動更新されません。`models.json` の `apiKey` を新しい `cached-auth.mjs` の絶対パスへ変更してください。ホーム配下のコピーを続ける場合は、`cached-auth.mjs` を同じ場所へコピーし、`apiKey` のパスも `.mjs` に変えます。既定 cache-dir と key が同じなら、既存の `~/.ensemble/pi/cache/auth/default.token` / `default.meta` は再利用されます。新しい entrypoint で読めることを確認してから旧 shell コピーを削除できます。

#### macOS で hit 時間を測る

リポジトリ clone から次を実行します。ベンチは一時 cache-dir に `benchmark-token` を作り、`/bin/sh` から Node の shebang script を新しい process として起動します。10 組の no-op / hit を交互の順序で測り、各組の `hit - no-op` と p50 を出します。hit 側では、キャッシュが外れて内側コマンドが実行された場合に一時 marker を作るため、実際の credential command を使わず hit を確認できます。終了時に一時ディレクトリを削除します。

```bash
node scripts/pi/bench-cached-auth.mjs
```

出力には platform / architecture、Node.js の版、10 組それぞれの no-op / hit 時間と差分、各 p50 が表示されます。これらの性能値は helper の起動コストと追加遅延を把握するための参考情報で、今回の Issue / PR の完了判定には使いません。hit / no-op の絶対 p50 と全サンプルを環境情報とともに記録してください。

ベンチスクリプトには以前の比較値を表示する `macOS acceptance (<= 25 ms)` 診断と、macOS でその値を超えたときに終了コード 1 を返す挙動が残っています。これは未変更のスクリプト動作です。オペレータの判断により、25 ms は現在の Issue / PR の受け入れ gate ではなく、測定値とともに参考情報として扱います。

2026-10-16 の初回測定は macOS 15.7.9（build 24G830、Apple Silicon / arm64）で、Node.js 24.16.0 の hit p50 が **148.72 ms**、no-op 起動 p50 が **128.72 ms**でした。Node.js 22.22.3 の hit p50 は **346.56 ms**でした。これらは当時の測定記録です。

2026-10-17 に同じ Mac で新しい paired ベンチを実行しました。別プロセスを止めずに計測したため、no-op の絶対時間にも大きなばらつきがあります。paired `hit - no-op` p50 は Node.js 24.16.0 で **30.65 ms**、Node.js 22.22.3 で **11.12 ms**でした。これらも pass/fail 判定ではなく参考値です。

| Node.js | no-op p50 | hit p50 | paired `hit - no-op` p50 |
|---------|-----------|---------|--------------------------|
| 24.16.0 | 516.14 ms | 577.82 ms | **30.65 ms** |
| 22.22.3 | 597.53 ms | 606.35 ms | **11.12 ms** |

10 組のサンプルは次のとおりです（各列は同じ組の no-op / hit / 差分）。

| Node.js | no-op ms | hit ms | hit − no-op ms |
|---------|----------|--------|----------------|
| 24.16.0 | 758.75, 449.12, 514.32, 464.70, 511.93, 517.96, 669.41, 495.54, 601.80, 563.23 | 514.07, 609.14, 659.47, 610.92, 543.98, 546.50, 623.96, 524.79, 528.54, 646.49 | -244.69, 160.02, 145.15, 146.22, 32.05, 28.54, -45.45, 29.25, -73.26, 83.26 |
| 22.22.3 | 807.09, 547.69, 598.60, 547.81, 581.10, 596.45, 782.49, 618.37, 629.50, 585.55 | 531.15, 610.22, 717.29, 602.47, 549.25, 597.37, 700.96, 595.58, 650.81, 637.55 | -275.94, 62.53, 118.69, 54.67, -31.85, 0.92, -81.53, -22.79, 21.31, 52.00 |

測定したのはこの Mac のみです。no-op p50 が 500 ms を超え、差分にも負値を含むため、同時稼働プロセスの影響が見える測定として扱います。安定した負荷条件の測定は未実施です。

## `ensemble auth` と Cursor の違い

| | Cursor backend（明示選択） | Pi backend（既定） |
|---|---|---|
| backend の選択 | `conductor.backend: cursor` | `conductor.backend` を省略 |
| login | `ensemble auth login` → Cursor SDK | `ensemble auth login --provider <id>` → provider 単位の Pi runtime |
| API key | `CURSOR_API_KEY` または Cursor SDK の stored login | Pi の TTY secret prompt / `--api-key-stdin` は user `auth.json` に保存します。request 時は project auth、`settings.json.apiKeys`、Pi provider 設定や環境・ambient auth が優先される場合があります（上記の解決順を参照） |
| OAuth / 出力 | Cursor SDK の login | TTY の Pi OAuth flow。URL / device code は stderr |
| model list | Cursor SDK の catalog | 認証済み Pi model のみ。`--provider` で絞り込み |
| worker の認証 | Cursor worker は `agent login`。Pi BYO は Pi CLI が使う provider credential を用意 | Cursor worker は `agent login`。Pi BYO は Pi CLI が使う provider credential を用意。Pi builtin worker は Pi conductor と同じ user root の `auth.json` または provider 環境変数を使う |

Pi builtin worker と Pi conductor は同じ Pi user root を使います。既定は `~/.ensemble/pi/` で、`conductor.pi.agentDir` が設定されていればその directory、なければ `PI_CODING_AGENT_DIR` が使われます。builtin worker の session map と transcript はこの設定から独立し、Issue と worker ごとの `~/.ensemble/pi/worker/<repoKey>/issue-<issueNumber>/<workerKey>/` に保存します。同じ repository で別 Issue の同名 worker を同時に動かしても map は共有しません。POSIX では wrapper が directory を `0700`、map / transcript を `0600` にし、新規 file は `umask 077` で制限します。Windows では wrapper が `icacls.exe` で専用 parent と repository storage tree を現在の account SID のみに許可し、PowerShell の .NET ACL API で owner と DACL を読み戻して検証します。ACL を設定・検証できない場合は builtin worker を起動しません。この制限は worker の map / transcript 用であり、共有 Pi settings / auth root には適用されません。同じ OS account の process、管理者 / SYSTEM / backup privilege、ACL を無視する storage、指定先外への書込みや upstream の権限拡大までは保護しません。詳細は [ADR 0070](adr/0070-issue-scoped-builtin-pi-storage.md) と [ADR 0071](adr/0071-builtin-pi-storage-windows-acl.md) を参照してください。

Pi builtin worker を使う場合、`ensemble auth login --provider <id>` は選択中の conductor backend が Pi のとき、解決済み user root の `auth.json` に credential を保存し、worker と共有します。Cursor backend を config / profile で選んでいるときは `--provider` だけで Pi login には切り替わらないため、Pi backend の config / profile を選ぶか、provider 環境変数を設定してください。Cursor backend のまま Pi CLI から login する場合は、同じ directory を `PI_CODING_AGENT_DIR` に指定してください。Pi CLI の global install は不要ですが、provider credential は必要です。

Cursor backend の既存 `ensemble auth login`、`CURSOR_API_KEY`、model catalog の挙動は Pi の設定では変更されません。

## 認証エラーからの復旧

### login 前の missing key

次を順に確認します。

1. `settings.json` の `defaultProvider` / `defaultModel` または `ensemble issue --model` が意図した provider/model を選んでいるか確認する。
2. `ensemble auth status --provider <provider-id>` で現在の `source` を確認する。`configured=true` は認証 request の成功を保証しない。
3. `source` を設定場所の手掛かりとして使い、次の優先順と照合する。
   - `runtime`: user → project に merge された `settings.json.apiKeys[provider]` の非 command 値。project 側が両方に設定した値を上書きします。値が非空なら user `auth.json` より先に request で使われます。ただし空文字も runtime と表示される一方、Pi request resolver はその値を使わず user `auth.json` など下位 source の読取りへ進みます。空 entry の場合は `source` だけで実効 credential を判断せず、下位の設定層も確認してください。
   - `project_stored` / `project_oauth_unsupported`: project `auth.json` の entry。API key / command は user 層より先に使われ、project OAuth は拒否されます。後者は project OAuth entry を除去して user 層で login します。
   - `stored`: user `auth.json` の credential。status は API key と OAuth を区別しません。
   - `settings_json`: Pi status が configured source を返さず Ensemble が検出した settings 候補です。scalar `apiKey` が先で、なければ `apiKeys[provider]` を見ます。key / command と user / project の別は分かりません。
   - `fallback`: Pi runtime に登録された `models.json` provider の通常 key。環境変数参照は登録前に展開されています。
   - `models_json_command`: Pi runtime に登録された `models.json` provider の `!command`。
   - `models_json_key`: Ensemble が直接 fallback した `models.json` 候補。通常 key と `!command` を区別しません。request 時の settings command は status に登録されないため、これらの source が表示されても request では settings command が選ばれる場合があります。
   - `environment`: Pi の provider auth check または Ensemble の provider-env fallback です。`label` があれば確認し、Pi の ambient auth（AWS profile / ADC など）の可能性も考慮します。source 名だけで process 環境変数だとは判断できません。
4. 設定値が `$NAME` / `${NAME}` なら参照先を確認し、更新する場合は値を画面や log に表示しないでください。`settings_json` / `models_json_key` / `models_json_command` / `project_stored` の entry に command が含まれていても、`auth status` は実行しません。status は command の実効性も確認しないため、user / project の両 resource root と request の優先順を確認します。
5. source に対応する設定層を直した後に provider の login を使う場合は、その provider の現行 login flow を確認します。user `auth.json` を更新しても、有効な非空の `settings.json.apiKeys[provider]` runtime override や project `auth.json` entry は置き換わりません。`apiKeys[provider]` が空文字なら、status は `runtime` と表示する一方で request は user credential などへ進みます。OpenAI の `ensemble auth login --provider openai` は既定で OAuth に進みます。API key を user `auth.json` に保存するには `--api-key-prompt` または `--api-key-stdin` を指定してください。`OPENAI_API_KEY` は保存せず request 時に利用できます。
6. `ensemble models list --provider <provider-id>` で対象 provider の model が見えることを確認する。

### 実行中の 401 / auth error

Pi の auth-like error では harness が同じ agent ID の reconnect を一度試みます。transport failure も既知の transport signal に限って同じ reconnect を行います。**失敗した prompt は自動再送しません。** `send()` 自体が reject した場合は結果不明として扱い、raw error の本文を保存せず、手動 reconnect まで後続 dispatch を止めます。認証の解決方法は上記の `ensemble auth status` / `ensemble auth login` と、表示される provider 固有 hint を確認してください。

現行の Pi hint は credential source を判別せず、provider login、user auth file、provider 環境変数などを共通案内します。

hint には次の情報が含まれます。

- `ensemble auth login --provider <provider-id>`
- `agentDir/auth.json`（既定 `~/.ensemble/pi/auth.json`）
- Pi が認識する provider 固有の環境変数名（例: Anthropic は `ANTHROPIC_OAUTH_TOKEN` / `ANTHROPIC_API_KEY`、OpenAI は `OPENAI_API_KEY`、GitHub Copilot は `COPILOT_GITHUB_TOKEN`）
- 稼働中の対話 TTY では `/reconnect` で接続を回復し、`/recovery list` / `/recovery show <recoveryId>` で未完了になった operator input を確認します。失敗した内容は再送せず、現在の状態と副作用を確認してから必要な続きを新しい operator message として送ります。`/recovery continue` は後続 queue の gate を解放するだけです。

自動 reconnect 中に旧 agent の `close()` が reject した場合は自動復旧を止めます。operator が明示的に `/reconnect` した場合は、同じ `agentId` の `resume` を試し、reject 済みの `close()` は繰り返しません。close failure を経たことと、旧 resource の解放が確認できないことを通知します。resume にも失敗した場合は、次の `/reconnect` で resume だけを再試行します。いずれの場合も失敗 input は再送せず、状態確認後の `/recovery continue` まで後続 dispatch を止めます。

inbox は最大4件・30分・合計4 MiB、1 dispatch あたり1 MiBです。send 前の容量予約ができない場合は入力を既存 queue に残し、`/recovery clear <id>` または TTL 後まで dispatch を待ちます。failure 後に内容を切り詰めたり古い snapshot を削除したりしません。

この共通 hint は source に応じた案内ではありません。`source=runtime` や project entry が有効なときに user login / user auth file の案内を実行しても、実効 credential は変わりません。また、`settings.json` command が status に現れず `fallback` / `models_json_command` / `environment` など下位 source が表示される場合もあります。現行 status の `source` だけで更新先を決めず、上記の request 優先順に沿って設定層を確認してください。

`apiKeys[provider]` が空文字のときも、status だけで更新先を決めないでください。現行 status は user / project のどちらの `settings.json` に entry があるかを示しません。両方の settings root と、user / project の `auth.json` / `models.json`、provider の環境設定を確認してください。空 entry を修正・削除する場合は、対象 root と、その後に有効になる下位 credential を確認してから行い、秘密値を画面や log に出さないでください。

recovery snapshot は、実際に dispatch した operator-authored input だけを保持します。Cursor の compiled prompt、Pi kickoff、worker result、permission payload、GitHub update、raw error は複製しません。本文は secret を含む可能性があり、一般的な redaction や TTY recording / 画面共有からの秘匿は保証しません。stdin / stdout / stderr がすべて TTY の場合に限って本文を確認できます。非 TTY では本文を保存・表示せず、同一 process 内でも確認できない旨を本文なしで通知します。inbox と queue は process 終了後に破棄し、`--resume` / `--continue` では復元しません。

operator-agent の watch report は既存の report ID による at-least-once retry を続け、user input と混ぜません。failure 後の通知は conductor の model-facing report ではなく local operator warning です。認証・retry・queue lifecycle の詳細は [conductor send の再接続](conductor-auth-reconnect.md)、入力操作は [オペレータ入力](operator-input.md) を参照してください。

## 参照

- [設定値リファレンス](settings.md) — backend、設定層、全体の解決順
- [ensemble 共通設定](config.md) — `config.yaml`、Pi resource root、headless 対応範囲
- [conductor 認証再接続](conductor-auth-reconnect.md) — send の再接続と auth hint の設計
- [ADR 0025](adr/0025-conductor-agent-backend-sdk-and-pi.md) — Cursor SDK / Pi backend の設計判断
- [ADR 0072](adr/0072-conductor-dispatch-lifecycle-and-recovery-boundary.md) — dispatch の失敗後の operator recovery
- [ADR 0074](adr/0074-manual-resume-after-close-failure.md) — close failure 後の明示 reconnect
