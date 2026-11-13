# ADR 0061: Conductor 認証モードと status / 復旧案内の契約

- Status: proposed
- Date: 2026-11-13
- Related: [ADR 0028](0028-authentication-delegation-and-ensemble-auth.md), [Issue #680](https://github.com/otolab/agents-ensemble/issues/680), [Epic #679](https://github.com/otolab/agents-ensemble/issues/679), [Issue #356](https://github.com/otolab/agents-ensemble/issues/356), [Issue #681](https://github.com/otolab/agents-ensemble/issues/681), [Issue #682](https://github.com/otolab/agents-ensemble/issues/682), [Issue #683](https://github.com/otolab/agents-ensemble/issues/683), [Issue #684](https://github.com/otolab/agents-ensemble/issues/684), [Issue #685](https://github.com/otolab/agents-ensemble/issues/685), [Pi conductor セットアップと認証](../pi-conductor-setup.md), [settings.md](../settings.md) パターン E

## Context

`ensemble auth` は Cursor SDK の保存型 login と、Pi conductor の provider 単位の login / status を提供する。Pi では TTY の API key prompt と OAuth flow が user `auth.json` を使う。実行時には project `auth.json`、user `ModelRuntime`、Pi resource の `settings.json` / `models.json`、provider 環境変数から credential を解決し、project の OAuth entry は refresh できないため拒否する。

Pi の `!command` はすでに Pi resource の API key として実行時に委譲できるが、`ensemble auth` からの登録導線はない。Issue #356 では command 登録を非スコープとした。その後、Epic #679 が複数認証モードの設計と登録 UX を改めて対象にした。#356 の判断を当時の履歴として残しつつ、登録を認める条件をここで整理する。

現行 `PiProviderAuthStatus` には mode / scope がなく、`source` は任意の `string` で、Pi runtime の値をそのまま返す場合もある。Ensemble 側の主な出所ラベルは `stored`、`project_stored`、`settings_json`、`models_json_key`、`environment`、`project_oauth_unsupported`。この値だけでは、たとえば `settings.json` の文字列 key と `!command` を見分けられない。認証エラー時の Pi hint も provider 共通で、effective source に応じた分岐はしない。

ADR 0028 は accepted のため本文を変更しない。本 ADR は、Issue #680 が求める認証方式の分類、status の拡張方針、復旧案内の設計を提案する。以下で「現行」と記す内容は調査時点の実装・docs の説明であり、Decision に記す status / hint / command 登録の契約は実装済みの仕様ではない。後続 Issue の実装がマージされるまで現行動作を変更せず、この ADR も現行動作の安全性を保証するものではない。

## Decision

### 1. 認証方式と scope を分ける

次の識別子を設計上の taxonomy とする。`oauth_browser` と `oauth_manual` は login 時の対話方式、`api_key_stored` / `command_delegated` / `environment` は credential の管理・取得方式を表す。`project_override` は方式ではなく、project 層が選ばれた状態を示す scope と優先順位の修飾子とする。

| ID | 分類 | 保存先・現行の導線 | 利用者への案内 |
|----|------|------------------|----------------|
| `oauth_browser` | OAuth login flow | Pi provider の credential は user `auth.json` / `ModelRuntime` が管理する。Cursor backend は Cursor SDK の user auth store を使う。実際の browser 起動方法は provider による | Pi は `ensemble auth login --provider <provider>`、Cursor は `ensemble auth login` を使って再認証する |
| `oauth_manual` | OAuth login flow | URL、device code、manual code を使う flow。保存先と refresh は `oauth_browser` と同じ | Pi の provider login を再実行し、表示された URL / code で login を完了する。challenge は認証操作中だけ operator に渡す |
| `api_key_stored` | 保存型 API key | Pi の TTY secret prompt が user `auth.json` に保存する。project credential や resource fallback が優先される場合は、それらが有効なことがある | user credential を更新する場合は `ensemble auth login --provider <provider>` を使う。値を CLI 引数やログへ書かない |
| `command_delegated` | command による実行時取得 | Pi resource の `settings.json` / `models.json` または project `auth.json` にある `!command` を Pi runtime が実行時に解決する。現行 CLI に command 登録機能はない | command と認証元を信頼できる設定で確認・修正する。これは `ensemble auth login` の保存型 credential ではない |
| `environment` | process 環境変数 | credential は保存せず、provider が認識する環境変数から取得する | 対応する変数を設定・ローテーションする。login は環境変数を変更しない |
| `project_override` | scope / 優先順位 | project の `auth.json` または `settings.json` / `models.json` の credential が解決順で選ばれた状態。project `auth.json` の API key / command は user credential より優先される | project 側で選ばれた値を確認・更新する。user login が effective credential を変えない場合がある。project OAuth は拒否されるため user 層へ移す |

この表の保存先は Pi backend の設定を中心に示す。Cursor backend の既存 login・保存先・環境変数の挙動は変更しない。

同じ provider でも、保存済み credential の種類と設定層は別の軸である。status は「どこから来たか」と「どの方式か」を別々に示す。OAuth credential の保存形式からは browser と manual のどちらで login したか分からないため、status は `oauth` までを示し、login 時の対話方式を推測しない。

### 2. status の source 互換性

既存の `source` は credential の出所を表す粗い分類として維持し、`settings_json` を `settings_json_command` に置き換えるなど、既存値を mode ごとに改名しない。command / key / OAuth の種別と project / user の scope は、将来の optional metadata で表現する。

`oauth_browser` / `oauth_manual` は login 時の対話方式であり、保存された OAuth credential からは区別できない。そのため status の `mode` はどちらも `oauth` とし、対話方式を記録・推測しない。

```typescript
interface PiProviderAuthStatus {
  provider: string;
  configured: boolean;
  source?: string; // 既存の出所ラベルを維持
  mode?: 'oauth' | 'api_key' | 'command' | 'environment';
  scope?: 'user' | 'project';
  label?: string; // provider 環境変数名など、秘密値を含まない補足
}
```

これは実装案であり、現行の型・出力ではない。新しい optional field の追加は、既存の `source` を読む利用者が未知の field を無視できる形にする。`source` の型を閉じた union に狭める変更は、任意文字列を扱う TypeScript 利用者に source-level の影響がある。既存の値を別名へ置き換えると、CLI 出力を完全一致で比較する利用者にも影響する。そのため、既存の `source` 値を保ったまま `mode` / `scope` を付加する。

将来の `mode` は `oauth_browser` / `oauth_manual` を `oauth`、`api_key_stored` を `api_key`、`command_delegated` を `command` として示す。`environment` はそのまま `environment` とする。`project_override` は mode にせず、実際に project 層の credential が選ばれた場合の `scope: 'project'` で表す。process 環境変数など user / project に属さない場合は `scope` を省略する。

### 3. 復旧 hint の対応表

次の表は mode-aware hint の設計案である。現行 Pi hint は source を判別せず、provider login、auth file、環境変数、`/reconnect` または session 再開を共通案内する。

| effective mode / scope | 次に案内する操作 |
|------------------------|------------------|
| `oauth_browser` / `oauth_manual`（status 上は `oauth`） | Pi は `ensemble auth login --provider <provider>`、Cursor は `ensemble auth login` を再実行する。provider が提示する browser / URL / device code / manual code の flow を完了する。保存後に flow の違いを判別できないため、両者で同じ案内にする |
| `api_key_stored` | TTY の secret prompt で user credential を更新する。API key を command line や hint に含めない |
| `command_delegated` | 信頼できる resource root の command 設定・認証元を確認する。status / hint で command、stdout、stderr を表示しない |
| `environment` | Pi は provider の環境変数名、Cursor は `CURSOR_API_KEY` を示し、値の設定・ローテーションを促す。値は表示しない |
| `scope=project` + API key / command | project 側で選ばれている値を確認・更新する。user `auth login` が effective credential を変えない場合があると伝える |
| `scope=project` + OAuth | project OAuth は unsupported と明示し、project entry を除去して user 層で login するよう案内する |
| source / mode 不明 | credential を削除する操作へ誘導せず、設定層の確認を促す共通 hint にする |

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

### 5. `!command` 登録を再検討できる条件

ADR 0028 と Issue #356 の移譲・非スコープ方針は、command 登録を常に禁止する判断ではない。Epic #679 で登録導線を再検討するときは、次の条件を満たす設計にする。

- command を登録する操作を明示し、登録時や `auth status` では command を実行しない。実行は provider request に必要なときだけ Pi runtime に委譲する。
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
