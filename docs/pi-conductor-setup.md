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

`defaultModel` に `<provider-id>/<model-id>` を指定することもできます。選択中の model を `conductor.model` または `ensemble issue --model <provider>/<model>` で明示した場合は、それが Pi の設定より優先されます。provider を省略しても、model id から一意に決まる場合は推測されます。

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

project 層の `auth.json` にある OAuth entry は refresh 対象になりません。project の明示的な OAuth credential は実行時に拒否されるため、project 側の stale entry を除去または置き換えたうえで、`ensemble auth login --provider <oauth-provider-id>` を user 層に実行してください。login は project `auth.json` を上書きしません。

### 4. 状態と model を確認する

```bash
ensemble auth status
ensemble models list
ensemble models list --provider <provider-id>
```

`auth status` は Pi の auth file の場所、provider ごとの configured 状態、credential の source を秘密値なしで表示します。`models list` は Pi の `ModelRegistry` と解決済み resource を使い、認証済み provider の model だけを表示します。対象 provider を `--provider` で絞れます。認証済み model が無い場合は Pi 向けの login / auth file / 環境変数の案内を含むエラーになります。

### OpenAI 互換 provider の catalog を比較・追加する

LiteLLM など、`models.json` に OpenAI 互換 endpoint として設定した provider は、明示的に `models sync` を実行して `/v1/models` catalog を確認できます。provider には `api: "openai-completions"` など Pi の OpenAI 互換 `api` と `baseUrl` が必要です。`baseUrl` は Pi の API base URL（通常は末尾が `/v1`）を指定してください。末尾が `/v1` なら `/models`、それ以外なら `/v1/models` を追加して取得します。

```bash
# API only / JSON only / 両方にある ID を表示（models.json は変更しない）
ensemble models sync --provider litellm

# API にある ID を選んで user models.json に追加
ensemble models sync --provider litellm --target user --add gpt-6-luna

# project models.json に追加
ensemble models sync --provider litellm --target project --add gpt-6-luna

# 同じ比較結果を機械処理する
ensemble models sync --provider litellm --json
```

追加時は `--add <id>` を繰り返して複数 ID を指定できます。書込先は `--target project|user` で明示してください。project は `conductor.pi.projectDir`（既定 `<repoRoot>/.ensemble/pi`）、user は `conductor.pi.agentDir`（既定 `~/.ensemble/pi`）にある `models.json` です。既存の provider 設定と model 定義は残し、同じ ID がすでに有効なら更新せずスキップします。API にない ID の削除や既存定義の force update は行いません。

user の `models.json` に追加しても、project の同じ provider に `models` 配列がある場合は Pi の project 優先により user 配列が隠れます。その場合はコマンドが書込前に停止するので、`--target project` を選んでください。

このコマンドは Pi provider の `baseUrl`、`apiKey`（環境変数参照や `!command` を含む）、`authHeader` と既存の Pi credential 解決を使って catalog を取得します。認証情報、header、provider の応答本文は出力しません。ネットワーク接続は `models sync` の明示実行時だけで、conductor の通常の `ModelRuntime` は引き続き `allowModelNetwork: false` です。

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

Pi の send が missing key、401、unauthorized などを返すと、harness は provider 固有の復旧 hint を表示します。hint には次の情報が含まれます。

- `ensemble auth login --provider <provider-id>`
- `agentDir/auth.json`（既定 `~/.ensemble/pi/auth.json`）
- Pi が認識する provider 固有の環境変数名（例: Anthropic は `ANTHROPIC_OAUTH_TOKEN` / `ANTHROPIC_API_KEY`、OpenAI は `OPENAI_API_KEY`、GitHub Copilot は `COPILOT_GITHUB_TOKEN`）
- 現在の conductor を再試行する `--resume <agentId>`（または `--continue`）

認証を直した後、終了 JSON や hint に示された agent id を使って再開します。

再接続の in-process retry、auth error の判定、backend 固有 hint の設計は [conductor-auth-reconnect.md](conductor-auth-reconnect.md) が正本です。

## 参照

- [設定値リファレンス](settings.md) — backend、設定層、全体の解決順
- [ensemble 共通設定](config.md) — `config.yaml`、Pi resource root、headless 対応範囲
- [conductor 認証再接続](conductor-auth-reconnect.md) — send の再接続と auth hint の設計
- [ADR 0025](adr/0025-conductor-agent-backend-sdk-and-pi.md) — Cursor SDK / Pi backend の設計判断
