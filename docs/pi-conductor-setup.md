# Pi conductor セットアップと認証

> **正本:** `ensemble issue` の Pi conductor を初回設定し、provider 認証を取得・確認・復旧する利用者向け手順。

このガイドは `conductor.backend: pi` を選んだときの conductor の設定を説明します。worker の ACP preset `pi` や、Pi CLI の通常の `<cwd>/.pi/` 設定とは別の経路です。

## 最短セットアップ

### 1. Pi backend を選ぶ

リポジトリの `.ensemble/config.yaml`（またはユーザの `~/.ensemble/config.yaml`）に設定します。

```yaml
conductor:
  backend: pi
```

profile に `conductor.backend` がある場合は profile の値が config より優先されます。`backend` を指定しない場合の既定は Cursor です。

Pi の設定を置く場所は次の 2 層です。

| 層 | 既定の resource root | 用途 |
|----|----------------------|------|
| user | `~/.ensemble/pi/` | 個人の設定・user credential |
| project | `<repoRoot>/.ensemble/pi/` | リポジトリ固有の model/resource と project credential |

resource root は `conductor.pi.agentDir`（user）と `conductor.pi.projectDir`（project）で上書きできます。相対パスはリポジトリの root 基準、`~` はユーザ home 基準です。

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

#### API key provider

```bash
ensemble auth login --provider <provider-id>
```

TTY の secret prompt に API key を入力します。prompt と入力待ちは stderr に出力され、入力値は表示されません。成功した credential は user resource root の `auth.json`（既定では `~/.ensemble/pi/auth.json`）へ保存されます。`conductor.pi.agentDir` を指定している場合はその配下です。project の `auth.json` はこのコマンドでは書き換えません。

API-key login は対話的な TTY が必要です。CI や非 TTY では login prompt を使わず、下記の provider 環境変数または Pi resource の fallback を設定してください。

#### OAuth provider

```bash
ensemble auth login --provider <oauth-provider-id>
```

OAuth login も TTY が必要です。Pi 1.x の `ModelRuntime.login` が認証を行い、URL、device code、進捗、追加 prompt は stderr に出します。SSH では表示された URL / device code を別のブラウザで使えます。OAuth credential は user runtime に保存され、conductor の各 request で runtime が必要に応じて refresh します。

OpenAI provider（`openai`）の ChatGPT OAuth は installation ごとの UUID（device ID）を必要とします。login 時に user resource root の `settings.json` から `deviceId` を取得し、未作成なら生成して保存します。同じ `conductor.pi.agentDir` で login をやり直すと同じ ID が使われ、agentDir を変えると別の installation として ID が作られます。値を手で設定する必要はありません。

ChatGPT OAuth を使わない場合は、次の方法があります。

| 方法 | 手順 |
|------|------|
| OpenAI API key | `OPENAI_API_KEY` を設定すると、Pi runtime が request 時に API key として使います。`ensemble auth login --provider openai` は OAuth login を選ぶため、API key を保存する用途には使わないでください。OpenAI 公式の model ID を選びます。 |
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

`auth status` は Pi の auth file の場所、provider ごとの configured 状態、credential の source を秘密値なしで表示します。`models list` は Pi の `ModelRegistry` と解決済み resource を使い、認証済み provider の model だけを表示します。対象 provider を `--provider` で絞れます。認証済み model が無い場合は Pi 向けの login / auth file / 環境変数の案内を含むエラーになります。

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

選択された provider の request credential は、明示的な内部 API key override を除き、次の順で解決されます。

| 優先 | source | 説明 |
|------|--------|------|
| 1 | project `auth.json` | project resource root の provider entry。user runtime より先に読みます。 |
| 2 | user Pi runtime | user root の `auth.json` を Pi 1.x `ModelRuntime` が管理します。`ensemble auth login` の書込先で、OAuth refresh もここで行います。 |
| 3 | `settings.json` fallback / `models.json` provider key | `apiKey`、`apiKeys[provider]`、または `models.json` の provider `apiKey`。auth file に credential が無い場合に使います。 |
| 4 | provider 環境変数 | Pi が provider ごとに認識する環境変数。provider により名前が異なります。 |

project → user の優先関係は provider 単位です。project に API-key credential があれば user credential や環境変数より優先されます。project の OAuth entry は user credential へフォールバックせず、refresh 不可として拒否されます。

古い Pi API の説明で `AuthStorage` と呼ばれている user credential 層は、現在の Pi 1.0.x 経路では `ModelRuntime` が担います。利用者が意識する保存先と login の挙動は user `auth.json` です。

`settings.json` / `models.json` の `apiKey` は環境変数参照（`$NAME` / `${NAME}`）や `!command` を含められます。`!command` は conductor process の shell と OS 権限で実行されるため、信頼できる設定だけで使ってください。login の保存先や OAuth refresh の user runtime とは別の resource fallback です。詳細は [config.md](config.md#pi-resource-root) を参照してください。

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

| | Cursor backend（既定） | Pi backend |
|---|---|---|
| backend の選択 | `conductor.backend` を省略 | `conductor.backend: pi` |
| login | `ensemble auth login` → Cursor SDK | `ensemble auth login --provider <id>` → provider 単位の Pi runtime |
| API key | `CURSOR_API_KEY` または Cursor SDK の stored login | TTY secret prompt、user `auth.json`、Pi の provider env/fallback |
| OAuth / 出力 | Cursor SDK の login | TTY の Pi OAuth flow。URL / device code は stderr |
| model list | Cursor SDK の catalog | 認証済み Pi model のみ。`--provider` で絞り込み |
| worker の認証 | `agent login` は worker ACP 用 | 同じく `agent login` は worker ACP 用。conductor の Pi login とは別 |

Cursor backend の既存 `ensemble auth login`、`CURSOR_API_KEY`、model catalog の挙動は Pi の設定では変更されません。

## 認証エラーからの復旧

### login 前の missing key

次を順に確認します。

1. `settings.json` の `defaultProvider` / `defaultModel` または `ensemble issue --model` が意図した provider/model を選んでいるか確認する。
2. `ensemble auth status --provider <provider-id>` で user credential の状態と保存先を確認する。
3. `ensemble auth login --provider <provider-id>` を TTY で実行する。
4. login を使わない場合は、表示された provider 固有の環境変数、project `auth.json`、`settings.json` / `models.json` fallback を確認する。
5. `ensemble models list --provider <provider-id>` で認証済み model が見えることを確認する。

### 実行中の 401 / auth error

Pi の send が missing key、401、unauthorized などの認証エラーを返すと、harness は同じ agent ID で接続を張り直します。同じ send 中に tool call が始まっていなければ同じ prompt を 1 回だけ自動再試行し、tool が始まっていた場合は副作用の重複を避けて再送しません。send の最終結果が auth error の場合は provider 固有の復旧 hint を表示します。

hint には次の情報が含まれます。

- `ensemble auth login --provider <provider-id>`
- `agentDir/auth.json`（既定 `~/.ensemble/pi/auth.json`）
- Pi が認識する provider 固有の環境変数名（例: Anthropic は `ANTHROPIC_OAUTH_TOKEN` / `ANTHROPIC_API_KEY`、OpenAI は `OPENAI_API_KEY`、GitHub Copilot は `COPILOT_GITHUB_TOKEN`）
- 稼働中 TTY では `/reconnect`、状態確認後に新しい operator message。process 終了後は `--resume <agentId>`（または `--continue`）で session を再開し、新しい message を送る

実行中の `ensemble issue` で `API key auth failed for provider ...: Failed to resolve API key ...` が出た場合、該当する provider request の前に key resolver が失敗しています。Pi は同じ send 内で tool round ごとに key を解決するため、先行する tool の副作用がありうる点には注意してください。tool call 開始後は自動経路でも同じ prompt を再送しません。認証 helper を直した後に `/reconnect` すると、初回 send と自動 retry のどちらでも tool call が始まっていない batch だけを再キューします。同じ event の手動再キューは同一 process 中 1 回までです。tool call が始まっていた場合や、transport error など結果が曖昧な場合は重複実行を避けて再送しません。現在の状態を確認し、新しい operator message で未完了の作業を伝えてください。

`/close` または Ctrl+C で process を止めると、失敗 batch と event queue は SessionResumeStore に保存されず、`--continue` / `--resume` 後も自動再生されません。再開後は conductor / worker の状態を確認し、未完了分だけを新しい operator message で伝えてください。Ctrl+C の sidecar flush は best effort です。max-turns 到達後も `/reconnect` 自体は使えますが、再キューされた worker event は通常の max-turns 制限を受けます。新しい operator message で上限をリセットしてから dispatch される場合があります。

再接続の in-process retry、auth error の判定、backend 固有 hint の設計は [conductor-auth-reconnect.md](conductor-auth-reconnect.md) が正本です。

`ensemble operator-agent` も `ensemble issue` と自動 send retry helper を共有し、auth / transport error の後に同じ agent ID で再接続します。tool call が始まっていない send だけ同じ prompt を 1 回再送し、tool が始まっていれば再送しません。TTY の手動 `/reconnect` は operator-agent 自身の agent を close / resume する control 操作で、失敗した operator-agent prompt は再送しません。`ensemble issue` の driver にある Pi resolver failure batch の再キューも operator-agent には適用されません。

operator-agent が `send_operator_message` を呼ぶと、稼働中 Issue session の UDS 経由で新しい `operator.message` が queue に入ります。これは明示的な tool 呼び出しであり、どの reconnect 操作も自動では行いません。Issue session の TUI で `[operator]` として表示される文面も、実際に dispatch された `operator.message` の内容です。`conductor.transport.reconnect` の成功ログだけでは、手動操作か自動 reconnect か、また prompt が再送されたかは判別できません。retry 後も認証エラーが続く場合は stderr の Pi 向け hint に従って認証設定を直し、`ensemble operator-agent` を再起動してください。

## 参照

- [設定値リファレンス](settings.md) — backend、設定層、全体の解決順
- [ensemble 共通設定](config.md) — `config.yaml`、Pi resource root、headless 対応範囲
- [conductor 認証再接続](conductor-auth-reconnect.md) — send の再接続と auth hint の設計
- [ADR 0025](adr/0025-conductor-agent-backend-sdk-and-pi.md) — Cursor SDK / Pi backend の設計判断
