# ADR 0061: Conductor 認証モードと status / 復旧案内の契約

- Status: proposed
- Date: 2026-11-13
- Related: [ADR 0028](0028-authentication-delegation-and-ensemble-auth.md), [Issue #680](https://github.com/otolab/agents-ensemble/issues/680), [Epic #679](https://github.com/otolab/agents-ensemble/issues/679), [Issue #356](https://github.com/otolab/agents-ensemble/issues/356), [Issue #681](https://github.com/otolab/agents-ensemble/issues/681), [Issue #682](https://github.com/otolab/agents-ensemble/issues/682), [Issue #683](https://github.com/otolab/agents-ensemble/issues/683), [Issue #684](https://github.com/otolab/agents-ensemble/issues/684), [Issue #685](https://github.com/otolab/agents-ensemble/issues/685), [Pi conductor セットアップと認証](../pi-conductor-setup.md), [settings.md](../settings.md) パターン E

## Context

`ensemble auth` は Cursor SDK の保存型 login と、Pi conductor の provider 単位の login / status を提供する。Pi では provider に応じて TTY の API key prompt または OAuth flow が user `auth.json` を使う。OpenAI provider の現行 `ensemble auth login --provider openai` は OAuth を開始し、API key 保存の選択肢は提供しない。実行時には project `auth.json`、user `ModelRuntime`、Pi resource の `settings.json` / `models.json`、provider 環境変数から credential を解決し、project の OAuth entry は refresh できないため拒否する。

Pi の `!command` はすでに Pi resource の API key として実行時に委譲できるが、`ensemble auth` からの登録導線はない。Issue #356 では command 登録を非スコープとした。その後、Epic #679 が複数認証モードの設計と登録 UX を改めて対象にした。#356 の判断を当時の履歴として残しつつ、登録を認める条件をここで整理する。

現行 `PiProviderAuthStatus` には mode / scope がなく、`source` は任意の `string` で、Pi runtime の値をそのまま返す場合もある。この PR の base は [`@earendil-works/pi-coding-agent` 1.2.0](../../packages/core/package.json) に固定されている。headless loader は user → project の順に settings を merge し、`settings.json.apiKeys[provider]` の非 command 値を `ModelRuntime.setRuntimeApiKey()` に登録する。Pi 1.2.0 の `RuntimeCredentials.read()` は runtime override を credential store より先に返すため、project `auth.json` entry がない場合、user `auth.json` に同 provider の credential があっても request は `apiKeys[provider]` を使い、status は `source=runtime` となる。両 settings root に値があれば project 側が merge 結果に残る一方、merge 後に root の provenance は失われる。

request では、まず project `auth.json` の API key / command を確認し、project OAuth は拒否する。project entry がなければ Pi `ModelRuntime` が、非 command の `settings.json.apiKeys[provider]` runtime override、user `auth.json` credential、provider 設定、provider の環境・ambient auth の順に解決する。settings 候補は scalar `apiKey` が先で、なければ `apiKeys[provider]` を選ぶが、非 command の `apiKeys[provider]` はすでに runtime override として登録済みである。選ばれた settings `!command` は request 時に provider 設定へ登録されるものの、runtime override と user credential より後、`models.json` provider 設定より前に解決する。したがって同じ provider に runtime `apiKeys` と user credential がある場合は、どちらも settings command より優先される。`models.json` provider の key / command は Pi 1.2.0 の `ModelRuntime.registerProvider()` に渡され、通常の key（環境変数参照を先に展開した値を含む）は status で `fallback`、command は `models_json_command` と表示され得る。Pi が key を返さない場合や `ModelRuntime.getAuth()` が error になった場合、選ばれた command 候補があれば error とし、下位 fallback は行わない。command 候補がなければ Ensemble は追加 fallback として command でない settings 候補（scalar `settings.json.apiKey` が先、なければ `apiKeys[provider]`）、`models.json` provider key、provider 環境変数を順に確認する。

現行 status は project `auth.json` を先に確認し、次に Pi `ModelRuntime.getProviderAuthStatus()`、最後に Ensemble の settings / models / provider-env fallback を調べる。Pi status の順は runtime、stored、provider 設定、provider auth check である。Ensemble fallback の表示値には `settings_json`、`models_json_key`、`environment` がある。settings command は status 時に登録・実行されないため、user `auth.json` や runtime override がない場合、request では settings command が有効でも status が `fallback` / `models_json_command` / `environment` など下位の provider source を示すことがある。Pi の `source=environment` には環境変数以外の ambient auth（AWS profile / ADC 等）が含まれ得る。現行 `source` は status lookup の結果であり、request の実効 credential や成功を常に示すものではない。Pi の [`RuntimeCredentials.read()`](https://github.com/earendil-works/pi/blob/v1.2.0/packages/coding-agent/src/core/runtime-credentials.ts#L24-L28)、[`ModelRuntime` status](https://github.com/earendil-works/pi/blob/v1.2.0/packages/coding-agent/src/core/model-runtime.ts#L646-L655)、[`resolveProviderAuth`](https://github.com/earendil-works/pi/blob/v1.2.0/packages/ai/src/auth/resolve.ts#L28-L93)、provider 設定・status の [`provider-composer.ts`](https://github.com/earendil-works/pi/blob/v1.2.0/packages/coding-agent/src/core/provider-composer.ts#L718-L731) と、Ensemble の [`conductor-pi-auth.ts`](../../packages/core/src/conductor/conductor-pi-auth.ts) が根拠である。

この source だけでは、たとえば `settings.json` の通常 key と `!command` を見分けられない。認証エラー時の Pi hint も provider 共通で、effective source に応じた分岐はしない。

ADR 0028 は accepted のため本文を変更しない。本 ADR は、Issue #680 が求める認証方式の分類、status の拡張方針、復旧案内の設計を提案する。以下で「現行」と記す内容は調査時点の実装・docs の説明であり、Decision に記す status / hint / command 登録の契約は実装済みの仕様ではない。後続 Issue の実装がマージされるまで現行動作を変更せず、この ADR も現行動作の安全性を保証するものではない。

現行 CLI では backend を config / profile で選び、`ensemble auth login` は選択済み backend の login を実行する。Pi の OpenAI provider で `ensemble auth login --provider openai` を実行すると OAuth login になる。OpenAI API key は `OPENAI_API_KEY` や Pi resource から request 時に利用できるが、現行のこの login コマンドには user `auth.json` へ OpenAI API key を登録する選択肢はない。

Issue #684 と未マージの [PR #689](https://github.com/otolab/agents-ensemble/pull/689) が扱う setup では、最初に Pi（OpenAI）または Cursor を選ぶ。Pi を選んだ場合、OAuth は現行の login path に委譲し、OpenAI API key は PR #689 が setup 用に加える `authMethod: 'api_key'` 分岐から既存 core の保存処理を呼ぶ。これは現行 `ensemble auth login --provider openai` の選択肢ではない。Cursor は既存の Cursor SDK login に委譲する。この setup は選んだ backend を user config に保存するが、fallback default は Cursor のままであり、その変更は別の Phase B として扱う。本 ADR は backend 選択や setup を定めるものではなく、その後の認証 mode / status / recovery の語彙を提案する。

## Decision

### 1. 認証方式と scope を分ける

次の識別子を設計上の taxonomy とする。`oauth_browser` と `oauth_manual` は login 時の対話方式、`api_key_stored` / `command_delegated` / `environment` は credential の管理・取得方式を表す。`project_override` は方式ではなく、project 層が選ばれた状態を示す scope と優先順位の修飾子とする。

| ID | 分類 | 保存先・現行の導線 | 利用者への案内 |
|----|------|------------------|----------------|
| `oauth_browser` | OAuth login flow | Pi provider の credential は user `auth.json` / `ModelRuntime` が管理する。Cursor backend は Cursor SDK の user auth store を使う。実際の browser 起動方法は provider による | Pi は `ensemble auth login --provider <provider>`、Cursor は `ensemble auth login` を使って再認証する |
| `oauth_manual` | OAuth login flow | URL、device code、manual code を使う flow。保存先と refresh は `oauth_browser` と同じ | Pi の provider login を再実行し、表示された URL / code で login を完了する。challenge は認証操作中だけ operator に渡す |
| `api_key_stored` | 保存型 API key | Pi の API-key prompt を持つ provider は TTY から user `auth.json` に保存する。OpenAI の現行 login は OAuth のみ。未マージ PR #689 は setup に `authMethod: 'api_key'` 分岐を加え、その経路から既存 core の保存処理を呼ぶ提案だが、これは現行 login の機能ではない | API-key prompt を持つ provider の user credential は、その provider の login で更新する。OpenAI の `ensemble auth login --provider openai` は OAuth に進むため、API key の更新先として案内しない。#689 の setup API-key 経路を使う場合は `ensemble setup` で API key を選び直す。非対話時の案内は #682 の決定に従い、操作が確定するまでは command や flag を推測しない。値を CLI 引数やログへ書かない |
| `command_delegated` | command による実行時取得 | Pi resource の `settings.json` / `models.json` または project `auth.json` にある `!command` を Pi runtime が実行時に解決する。現行 CLI に command 登録機能はない | command と認証元を信頼できる設定で確認・修正する。これは `ensemble auth login` の保存型 credential ではない |
| `environment` | process 環境変数 | credential は保存せず、provider が認識する環境変数から取得する | 対応する変数を設定・ローテーションする。login は環境変数を変更しない |
| `project_override` | scope / 優先順位 | project の `auth.json` または `settings.json` / `models.json` の credential が解決順で選ばれた状態。project `auth.json` の API key / command は user credential より優先される | project 側で選ばれた値を確認・更新する。user login が effective credential を変えない場合がある。project OAuth は拒否されるため user 層へ移す |

この表の保存先は Pi backend の設定を中心に示す。Cursor backend の既存 login・保存先・環境変数の挙動は変更しない。

taxonomy ID と status の `source` / `mode` は別の軸である。`api_key_stored` は user `auth.json` に保存する login 経路を指す一方、`mode=api_key` は `settings.json.apiKeys` の runtime override や provider 設定にも使う。どこから来た key かは `source` と `scope` で示し、`mode=api_key` だけから保存先を推測しない。OAuth credential の保存形式からは browser と manual のどちらで login したか分からないため、status は `oauth` までを示し、login 時の対話方式を推測しない。

### 2. status の source 互換性

既存の `source` は credential の出所を表す粗い分類として維持し、`settings_json` を `settings_json_command` に置き換えるなど、既存値を mode ごとに改名しない。command / key / OAuth の種別と project / user の scope は、将来の optional metadata で表現する。特に `source=runtime` は既存 Pi SDK source なので維持し、headless conductor では非 command の `settings.json.apiKeys[provider]` runtime override を示す。この override は user `auth.json` より優先される。scalar `settings.json.apiKey` は runtime override ではなく、通常は `source=settings_json` となる Ensemble fallback である。

現行 source の意味と status lookup は次のとおり。これは現在の Pi `ModelRuntime` status と Ensemble fallback を合わせた観測で、将来の型を閉じる定義ではない。project `auth.json` の判定後、Pi status は runtime > stored > provider 設定 > provider auth check の順に返ります。Pi status に configured source がなければ、Ensemble は settings > models > provider 環境変数の順で source を付けます。

| 現行 `source` | 現行の表示内容 |
|---------------|----------------|
| `runtime` | Pi runtime API-key override。headless path では通常、非 command の `settings.json.apiKeys[provider]`。user `auth.json` より先に使われるが、user / project settings のどちらから来たかは分からない |
| `stored` | user `auth.json` の credential。API key / OAuth の種類は区別しない |
| `project_stored` | project `auth.json` の API key / command entry。entry の種類は区別しない |
| `fallback` | 現行 headless loader が `ModelRuntime.registerProvider()` に渡した `models.json` provider の通常 key。環境変数参照も登録前に展開するため、ここに含まれ得る |
| `models_json_command` | Pi provider 設定として登録した `models.json` command |
| `environment` | Pi の provider auth check、または Ensemble provider-env fallback。Pi の label は AWS profile / ADC など ambient auth を示す場合もある |
| `settings_json` | Pi status に configured source がなく、Ensemble が settings 候補を検出した場合。scalar `apiKey` が先、なければ `apiKeys[provider]`。通常の非 command `apiKeys` は `runtime` になる。key / command や user / project root は区別しない |
| `models_json_key` | Pi status に provider source がなく、Ensemble が `models.json` 候補を直接検出した場合。通常の headless `registerProvider()` path では通常 key は `fallback`、command は `models_json_command` が使われる。この直接 fallback source だけでは通常 key と `!command` を区別しない |
| `project_oauth_unsupported` | project `auth.json` の OAuth entry。未設定扱いで request を拒否する |

request 時にだけ登録する `settings.json` command は status で実行も登録もしません。user credential / runtime override がなければ request ではこの command が provider 設定として選ばれても、status は `models.json` provider key / command や `environment` を表示する場合があります。`source=models_json_key` も直接 fallback された候補が通常 key か `!command` かを示しません。将来の status は、command を実行せずに設定値の種別を判定して `mode` を示せない場合、`mode` を省略して共通案内へ回します。さらに `source=environment` は process 環境変数に限らず ambient auth を表すことがあります。したがって現行 `source` は status lookup の結果であり、request の実効 credential、認証の成功、設定 root を常に示すものではありません。

将来の status は、既存 source の語彙を保ちながら、request resolver の優先順に照らして選ばれる effective source と `mode` / `scope` を示す必要があります。`settings.json.apiKeys[provider]` の runtime override を user `auth.json` より先に扱い、request 時の settings command も実行せずに source / mode へ反映します。user / project settings の provenance も失わない方法を定めます。Pi SDK の `source=environment` だけから `mode=environment` を推定してはいけません。実際の process 環境変数だと確認できない ambient source は、mode を省略して安全な共通案内へ回すか、taxonomy を別途定めます。`source` は既存の任意 `string` 型を保ち、Pi SDK の `models_json_key` など未列挙値も受け入れます。

`oauth_browser` / `oauth_manual` は login 時の対話方式であり、保存された OAuth credential からは区別できない。そのため status の `mode` はどちらも `oauth` とし、対話方式を記録・推測しない。

```typescript
interface PiProviderAuthStatus {
  provider: string;
  configured: boolean;
  source?: string; // 既存の出所ラベルを維持
  mode?: 'oauth' | 'api_key' | 'command' | 'environment';
  scope?: 'user' | 'project';
  label?: string; // 秘密値を含まない provider / auth source の補足
}
```

これは実装案であり、現行の型・出力ではない。新しい optional field の追加は、既存の `source` を読む利用者が未知の field を無視できる形にする。`source` の型を閉じた union に狭める変更は、任意文字列を扱う TypeScript 利用者に source-level の影響がある。既存の値を別名へ置き換えると、CLI 出力を完全一致で比較する利用者にも影響する。そのため、既存の `source` 値を保ったまま `mode` / `scope` を付加する。

将来の `mode` は `oauth_browser` / `oauth_manual` を `oauth`、`api_key_stored` を `api_key`、`command_delegated` を `command` として示す。`environment` はそのまま `environment` とする。`project_override` は mode にせず、実際に project 層の credential が選ばれた場合の `scope: 'project'` で表す。process 環境変数など user / project に属さない場合は `scope` を省略する。

Issue #682 の status もこの対応を使う。`api_key_stored` は taxonomy 上の識別子であり、status の機械可読な `mode` 値は `api_key` とする。既存の `source` は出所として引き続き維持する。

### 3. 復旧 hint の対応表

次の表は mode-aware hint の設計案である。現行 Pi hint は source を判別せず、provider login、auth file、環境変数、`/reconnect` または session 再開を共通案内する。`source=runtime` の settings override や project entry が有効なとき、user login の案内だけでは実効 credential が切り替わらない。また、現行 status が `fallback` / `models_json_command` / `environment` を示しても、request 時だけ登録する settings command が実効 source の場合がある。将来 hint は status の source 名だけでなく、実際の resolver 順で選ばれる effective source、mode、scope を使う。command は実行せず、設定上の出所だけを判定する。

| effective status mode / scope / source（taxonomy ID） | 次に案内する操作 |
|------------------------------------------------------|------------------|
| `mode=oauth`（`oauth_browser` / `oauth_manual`） | Pi は `ensemble auth login --provider <provider>`、Cursor は `ensemble auth login` を再実行する。provider が提示する browser / URL / device code / manual code の flow を完了する。保存後に flow の違いを判別できないため、両者で同じ案内にする |
| `mode=api_key` + `source=runtime` | 有効な user / project `settings.json.apiKeys[provider]` entry を確認・更新する。project 側の値は user 側より優先され、`auth.json` login だけでは runtime override は置き換わらない。status が `scope` を持たない間は両 root を確認する |
| `mode=api_key` + `source=stored`（`api_key_stored`） | user `auth.json` の保存 credential を provider の API-key login で更新する。OpenAI の現行 `ensemble auth login --provider openai` は OAuth を開始し、API key は保存しない。OpenAI API key の setup 経路は未マージ PR #689 の提案であり、現行 login の機能として案内しない。非対話時は Issue #682 が決める user 層の入力経路を案内し、確定前の flag 名を推測しない |
| `mode=api_key` + `source=settings_json` | 有効な settings key を確認・更新する。scalar `apiKey` が先で、なければ `apiKeys[provider]`。この source だけでは user / project root を区別できないため、scope が分からなければ両 root を確認する |
| `mode=api_key` + `source=fallback` / `models_json_key` | effective source として確認できた場合に限り、`models.json` の provider `apiKey` を確認・更新する。現行 status は settings command を反映しない場合があるため、source 名だけを根拠に下位 key を更新させない。通常の registered provider key は `fallback`、Ensemble の直接 fallback は `models_json_key` と表示される。`models_json_key` だけでは key / command を区別できず、提案する `mode` も判定できない場合は共通案内にする |
| `mode=command`（`command_delegated`） | `source` / `scope` から信頼済み resource root の command 設定と認証元を確認する。status / hint は command、stdout、stderr を表示せず、command も実行しない |
| `mode=environment` | 実効 source が process 環境変数だと確認できる場合に限り、Pi は provider の変数名、Cursor は `CURSOR_API_KEY` を示して設定・ローテーションを促す。値は表示しない。Pi の `source=environment` が AWS profile / ADC など ambient auth を示す場合、環境変数だと決めつけず、安全な共通案内にするか別 taxonomy を定める |
| `scope=project` + API key / command | project 側で実効 source となった値を確認・更新する。user `auth login` が effective credential を変えない場合があると伝える |
| `scope=project` + OAuth | project OAuth は unsupported と明示し、project entry を除去して user 層で login するよう案内する |
| effective source / mode 不明 | credential を削除する操作へ誘導せず、現行の resolver 優先順と設定層を確認する共通 hint にする |

この表は hint の判断契約であり、現在の `formatConductorAuthRecoveryHint` の分岐を説明するものではない。復旧後の `/reconnect`、失敗した prompt の再送境界、`--resume` / `--continue` は [conductor-auth-reconnect.md](../conductor-auth-reconnect.md) の現行契約を維持する。

### 4. 将来契約: 秘密値を出力・ログへ残さない

以下は後続実装が満たすべき要件であり、現行実装の検証結果ではない。各 mode と scope で、API key、access / refresh token、環境変数の値を status、復旧 hint、SessionLogEvent、終了 JSON、recovery report、Issue / PR に含めない。

- `oauth_browser` / `oauth_manual`: token は出力しない。URL、device code、manual code は login 中に operator へ一時表示する場合に限り、status や永続 session log へ残さない。
- `api_key_stored`: secret prompt で受け取った値を status、hint、ログ、Issue / PR に含めない。
- `command_delegated`: command 文字列、stdout、stderr、実行結果、失敗 cause を status、hint、ログ、Issue / PR に含めない。
- `environment`: 変数名など秘密値を含まない label だけを表示し、値を出力しない。
- `project_override`: 選択される credential の種類にかかわらず、project 層にも同じ出力制約を適用する。

status に載せてよいのは provider、configured 状態、source、mode / scope、秘密値を含まない label に限る。

`!command` の stdout は Pi runtime に credential として返すだけにし、失敗時も command 本文・出力・cause の詳細を log に複製しない。

現行の [`formatPiCommandResolutionError`](../../packages/core/src/conductor/conductor-pi-auth.ts) は設定された command と `cause.message` を Error message に含める。設定値や cause に秘密が含まれると、エラーを表示・記録する経路で露出するおそれがある。この PR では実装を変更せず、Issue #683 で command、stdout / stderr、cause、credential を利用者向け error、session / harness log、recovery report、終了 JSON に含めない要件と、synthetic な秘密値を使った非露出テストを追跡する。

### 5. `!command` 登録を再検討できる条件

ADR 0028 と Issue #356 の移譲・非スコープ方針は、command 登録を常に禁止する判断ではない。Epic #679 で登録導線を再検討するときは、次の条件を満たす設計にする。

- command を登録する操作を明示し、登録時や `auth status` では command を実行しない。登録時に opt-out 可能な dry-run を既定実行する案も採らない。登録時には command 文字列と書込先など実行を伴わない項目だけを検証し、実行は provider request に必要なときだけ Pi runtime に委譲する。
- dry-run など明示的な検証操作が将来必要になった場合は、登録フローとは別の設計として扱い、実行権限の警告と秘密値の非出力要件を定めてから提案する。
- 書込先の scope を利用者に示す。user 層を既定とし、project 層へ書く操作は明示指定を必要とする。通常の `ensemble auth login` は user credential の書込先を保つ。
- `!command` を単なる token 値として扱わない。command は設定に書かれた実行可能な内容であり、その実行結果も credential として機密扱いする。
- command は conductor process の shell / OS user / 環境で実行される。harness の worker permission や追加 sandbox が保護境界になるとは扱わない。project の Pi resource を含め、実行対象は operator が信頼した設定でなければならない。
- status と error / log は command の文字列・標準出力・標準エラー・credential 値を出さない。失敗理由は秘密を含まない要約にする。
- command の cache / TTL は harness が自動で付与しない。必要な token cache は明示した command helper へ委譲し、refresh の責務を説明する。
- 秘密値を `config.yaml` や commit される project resource に平文で保存しない。project resource を使う場合は repository の信頼性と ignore / commit 状態を確認する。

### 6. project OAuth 拒否（現行動作と維持条件）

現行実装は project `auth.json` の OAuth entry を `configured` と扱わず、request 時に拒否する。下位の user credential や環境変数へ暗黙に fallback もしない。この PR で挙動は変更しない。project 層では user `ModelRuntime` が持つ OAuth refresh を安全に継続できず、期限切れ token を user credential や環境変数へ暗黙に fallback すると利用者が選んだ project credential と異なる identity で request を送る可能性がある。今後も拒否を維持し、明示的な案内で user 層へ移す。

## Consequences

- login flow、credential source、scope を分けるため、`project_override` を OAuth / key / command と同列の認証方式として誤解しない。
- status は `source` の既存値を維持したまま、将来 mode と scope を追加できる。OAuth の対話方式を保存 credential から推測しない。
- command 登録は #356 の時点では非スコープだったが、Epic #679 で検討を再開できる。その実装は本 ADR の信頼境界と秘密値の出力制約を受ける。
- 本 ADR は設計提案であり、status、hint、command 登録の実装や worker 認証統合を含まない。後続の認証 Issue がこの契約を実装する。
