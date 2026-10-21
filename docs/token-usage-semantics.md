# LLM usage の意味論

> **正本:** conductor / worker が報告する LLM usage の意味と、harness が集計・表示するときの解釈。項目の型・出力先は [session-metrics.md](session-metrics.md) を参照。

## 1. まず押さえること

`ensemble issue` の token usage は、backend から受け取った値、または worker のテキストから推定した値をラウンド単位で記録したものです。すべての backend で同じ tokenizer・計上範囲・課金単位にそろえた値ではなく、provider の請求明細でもありません。

| 項目 | この文書での意味 |
|------|------------------|
| `inputTokens` | backend が input / prompt として報告した件数。harness では非 cache input のバケットとして扱うが、元データの意味は usage source による |
| `outputTokens` | backend が output / response として報告した件数。reasoning が内数か別枠かは backend による |
| `cacheReadTokens` | backend が cache から読んだ input として報告した件数 |
| `cacheWriteTokens` | backend が cache に書いた input として報告した件数 |
| `totalTokens` | backend が返した total。ACP が省略した場合は harness が input と output の和を使い、テキスト推定では推定 input と推定 output の和 |
| `reasoningTokens` | backend が分離して報告し harness が記録した reasoning 件数。Pi と codex-acp 2.2.2 では `outputTokens` の内数として扱う |

raw backend usage では、cache read / write が `inputTokens` に含まれるか別枠かは一律ではありません。ensemble の排他的バケットとして扱う条件と注意点は §3.3 に示します。source の意味を確かめずに raw fields を足し合わせて総 input を作らないでください。`totalTokens` も別 backend の値と直接比較できる共通の請求単位ではありません。

## 2. usage source ごとの値

`get_usage` の各ラウンドには `usage.source` が付きます。`sdk` は conductor backend が報告した値、`acp` は worker の ACP prompt 応答に含まれた値、`estimated` は ACP usage が無い worker のテキスト推定値です。

| source | input / output | cache / reasoning | 留意点 |
|--------|----------------|-------------------|--------|
| Cursor SDK (`sdk`) | `@cursor/sdk` の `TokenUsage.inputTokens` / `outputTokens` を記録 | `cacheReadTokens` / `cacheWriteTokens` / `reasoningTokens` があれば記録 | SDK が返す各項目をそのまま使う。SDK の `getUsage()` が返す課金値は §3 を参照 |
| Pi (`sdk`) | `AssistantMessage.usage.input` / `output` を `inputTokens` / `outputTokens` に写す | `cacheRead` / `cacheWrite` があれば写す。Pi の `reasoning` は `output` の内数だが、現行 adapter は harness の `reasoningTokens` に写さない | Pi は複数 provider の API を扱うため、実際の計上範囲は provider による。`usage.cost` はモデル定義の単価からの計算値 |
| ACP worker (`acp`) | 本リポジトリが `session/prompt` 応答の `usage.inputTokens` / `outputTokens` として受け取った値。`totalTokens` が無ければ harness がこの2項目の和を設定 | ACP wire の `cachedReadTokens` / `cachedWriteTokens` / `thoughtTokens` を、それぞれ `cacheReadTokens` / `cacheWriteTokens` / `reasoningTokens` に変換して記録 | ACP preset / agent ごとに報告の有無と意味を確認する必要がある。共通の ACP usage 契約としては扱わない |
| worker テキスト推定 (`estimated`) | prompt と応答テキストそれぞれの UTF‑8 byte 数を 4 で割って切り上げる | cache / reasoning は推定しない | model tokenizer を使わない粗い近似。provider が数えた token 数や課金量ではない |

Cursor SDK は `inputTokens`、`outputTokens`、cache read / write、`totalTokens` を usage として公開します。Pi の `Usage` 型も同様の区分を持ちますが、対応する API や provider は一つではありません。したがって、同じ項目名でも provider をまたいだ意味の同一性は保証されません。[Cursor SDK usage](https://cursor.com/docs/sdk/typescript)、[Pi `Usage` 型 v1.2.0](https://github.com/earendil-works/pi/blob/v1.2.0/packages/ai/src/types.ts)

ACP worker の `usage` は `session/prompt` 応答に任意で含まれるデータとして本リポジトリが読み取ります。usage が無い応答は、harness が prompt と応答テキストから推定します。ACP v1 の公式 schema は token usage / cache 計上を共通フィールドとして定義していないため、preset ごとの報告値を provider の usage 定義と照らして読む必要があります（[ACP v1 schema](https://github.com/agentclientprotocol/agent-client-protocol/blob/main/schema/v1/schema.json)、実装上の型は `packages/core/src/acp/types.ts`）。

Codex preset が使う codex-acp 2.2.2 は、wire の `cachedReadTokens` を内部の `cacheReadTokens` に、`cachedWriteTokens` を `cacheWriteTokens` に、`thoughtTokens` を `reasoningTokens` に写します。2.2.2 の Codex usage では `inputTokens` は cache read / write を除いた input、cache counters は別 bucket です。`thoughtTokens` は `outputTokens` に含まれる reasoning の内数です。変換後も `outputTokens` と wire の `totalTokens` はそのまま保ち、`reasoningTokens` をどちらにも足しません。harness は各項目を独立して集計し、wire に `totalTokens` がない場合の既定値だけ `inputTokens + outputTokens` とします（[codex-acp 2.2.2 token usage](https://github.com/agentclientprotocol/codex-acp/blob/v2.2.2/src/TokenCount.ts)、[adapter の変換](../packages/core/src/acp/acp-client.ts)、[集計実装](../packages/core/src/usage/session-usage-tracker.ts)）。

推定値は [estimateTokenUsageFromText](../packages/core/src/usage/estimate-token-usage.ts) が UTF‑8 byte 数から計算します。モデル tokenizer を使わず、画像などの非テキスト入力、内部 tool call、provider が追加する prompt 要素、非表示の reasoning も数えません。完了せず usage が記録されなかった worker ラウンドは、このテキスト推定にも含まれません。

## 3. harness 集計の読み方

`SessionUsageTracker` は usage を記録できた conductor / worker ラウンドごとに各カウンターを加算します。セッションサマリの `tokenScope: 'recorded-usage-only'` は、セッション中の全消費を保証しないという意味です。

### 3.1 集計単位と範囲

- usage の最小単位は `SessionUsageRound`（conductor の LLM 実行、または worker の prompt 応答）です。`get_usage` は直近 1 ラウンド、`get_session_usage` と終了 JSON の `sessionUsage` は記録されたラウンドのセッション集計です。
- SDK usage、ACP usage、worker テキストからの `estimated` usage が同じセッション集計に含まれる場合があります。usage を残さず終了した失敗ラウンドの消費分は含まれません。

### 3.2 集計値の読み方

- SDK がまとめて返したラウンド値、ACP の報告値、worker テキストからの推定値が同じ合計に入ることがあります。source 別の小計ではありません。
- `totals` / `byAgent` は各 source の `inputTokens`、`outputTokens`、`totalTokens`、cache counters を別々に加算します。`totalTokens` を `inputTokens + outputTokens` から再計算したり、cache counters を足して請求上の total を作ったりはしません。
- cache stats は cache counter を報告したラウンドだけから算出します。worker に cache 値が無ければ、`cacheStats.totals` は実質 conductor の cache 値だけという場合があります。「全体」は全 agent の cache を網羅した値ではありません。
- 現行の `cacheHitRate` は `cacheReadTokens` を報告したラウンドに限り、`sum(cacheReadTokens) / sum(inputTokens + cacheReadTokens)` で計算します。cache write は式に入りません。input が cache read と重ならないことを前提にした harness 内の比率であり、provider 共通の hit rate ではありません。たとえば Anthropic の prompt caching では `input_tokens` は cache read 分を含まないため、この区別が数値に表れます。100% は計算対象の cache read が `inputTokens + cacheReadTokens` の全量を占めたことを示しますが、cache 値を報告した一部 agent / round の結果であり、全 agent の全 input が cache hit したことを示すとは限りません。
- `context.percent` は全ラウンドの `inputTokens` 累計を、指定された context limit と比較した値です。現在の prompt が context window の何割を占めるかではなく、同じ会話履歴の再送や cache read もラウンドごとの値に従います。上限が不明なら percentage は出ず、算出値は 100% を上限として表示します。

### 3.3 排他的な input バケット

harness の集計モデルでは `inputTokens` を cache read / write を除く input、`cacheReadTokens` と `cacheWriteTokens` をそれぞれ独立した input バケットとして扱います。すべてがこの形に正規化された値であれば、input usage は 3 バケットの合計になり、コストをバケットごとの単価で計算できます。セッション集計では `totalTokens` も独立して加算し、cache bucket からは再計算しません。ACP がラウンドの `totalTokens` を省略した場合の fallback は §1 のとおりです。

ただし、元の provider / adapter が返す `inputTokens` に cache 分を含むかは source によって異なります。フィールド名だけを根拠に排他性を判断せず、包括値を排他バケットとして扱う場合は source の仕様に沿った変換が必要です。現行 tracker は入力値を source 横断で正規化せず、各 counter をそのまま加算します。

worker の `estimated` usage は応答テキストからの参考値であり、provider が報告した実測値ではありません。現行の `SessionUsageTracker` はこれを `totals.tokens` / `byAgent` に含めますが、外部の実測 usage・cache・cost 分析では source を分け、推定値を実測値と混ぜて合算しないでください。

各項目の型、出力先、実装箇所は [session-metrics.md §3](session-metrics.md#3-llm-usagesessionusagetracker)、外部規約との変換は [§8](#8-外部ツールとの対応)、TTY と export の整形は [§9](#9-表示とexportの整形) を参照してください。

## 4. token 数と provider 課金は別の情報

`sessionUsage.cost` がある場合、その値は Cursor SDK から取得した conductor の課金記録です。`chargedCents` は割引などを反映した額、`rawCostCents` は割引前の額です。課金記録は遅れて反映される場合があり、セッション全体の確定額を表すものではありません。worker cost は取得・算出しないため、scope は `conductor-only` です。

Pi の `AssistantMessage.usage.cost` は Pi に設定されたモデル単価と token usage から計算されます。provider の請求記録ではないため、harness の `sessionUsage.cost` には含めません。worker は usage に model ID がなく、単価を安全に対応づけられないため、cost を表示しません。

### 4.1 `cacheHitRate` はトークン比

`cacheHitRate` は cache read token の比率であり、cache によるドル削減率や provider の請求上の hit rate ではありません。計算対象の agent / round で token がどの程度 cache read として報告されたかを見る指標です。料金単価が異なる場合のコスト内訳とは別に読みます。

TTL による cache の失効や compaction による prompt 構成の変化は、金額だけでは追いにくいため、TTY では算出可能な hit rate を agent ごとの行に残します。分母、対象 round、cache write の扱いを含む現行の式は §3.2 に記載したとおりで、変更しません。

請求額の確認には、利用した provider / gateway の usage report や請求画面を使ってください。Cursor の SDK usage / cost と、チーム管理者向け [Admin API usage reports](https://cursor.com/docs/account/teams/admin-api) は Cursor 側の確認先です。たとえば Anthropic API の prompt caching では、`input_tokens` は cache breakpoint より後の uncached input、`cache_read_input_tokens` と `cache_creation_input_tokens` は別項目です。合計 input はそれら 3 項目の和で、cache read / write には通常 input と異なる料金が適用されます。[Anthropic prompt caching: usage fields](https://platform.claude.com/docs/en/build-with-claude/prompt-caching)、[Anthropic pricing](https://platform.claude.com/docs/en/about-claude/pricing)

cost や usage を継続的に監視する場合の参考:

- [OpenTelemetry GenAI token metrics](https://github.com/open-telemetry/semantic-conventions-genai/blob/main/docs/gen-ai/gen-ai-token-metrics.md) は token usage を記録・集計するための semantic convention です。現在も development 扱いで、請求台帳ではありません。OpenTelemetry の convention では cache read / write は input token の内数として扱うため、raw backend 値を出力する前に対応づけを確認してください。
- [Langfuse token and cost tracking](https://langfuse.com/docs/observability/features/token-and-cost-tracking) は受け取った usage / cost の記録に加え、登録済みモデル単価から cost を推定できます。推定額は provider の請求額とは区別してください。

## 5. usage 値の確認先

直近ラウンドの `get_usage` は、そのラウンドの `usage.source` と token counters を返します。`get_session_usage` と終了 JSON の `sessionUsage` はセッション集計で、source を含むラウンド詳細は `latestRound` だけです。各 tool / 出力の形は [session-metrics.md](session-metrics.md) を参照してください。

## 6. 表示と export

TTY のラベル、agent ごとの表示、合計行、脚注、および終了 JSON の扱いは [§9](#9-表示とexportの整形) を正本とします。フィールドの型と出力先の一覧は [session-metrics.md](session-metrics.md) を参照してください。

## 8. 外部ツールとの対応

各ツールで似た名前のフィールドが使われていても、値が包括値か排他的な内訳か、どの単位で集計するかは同じではありません。外部へ出す際は field name の置き換えだけで済ませず、source ごとの意味を確認してください。

| 概念 | ensemble | Langfuse | OpenTelemetry GenAI | Helicone |
|------|----------|----------|---------------------|----------|
| 入力 token | `inputTokens`（非 cache input として扱う。source の意味は別途確認） | `usage_details.input`。他の input 系 bucket と重ねない | `gen_ai.usage.input_tokens` は cache を含む入力全体 | `prompt_tokens`。API / provider ごとの意味を確認 |
| cache read / write | `cacheReadTokens` / `cacheWriteTokens` | `input_cached_tokens` などの独立した usage type | `gen_ai.usage.cache_read.input_tokens` / `gen_ai.usage.cache_write.input_tokens`。input 全体の内数 | `prompt_cache_read_tokens` / `prompt_cache_write_tokens` など |
| cache hit rate | `cacheHitRate` は §3.2 の token 比 | usage / cost bucket から別途集計 | 同じ定義の標準 field ではなく、token counters から必要に応じて算出 | request の cache token fields とは別の派生指標 |
| 出力 token | `outputTokens` | `usage_details.output`。reasoning 等の別 bucket がある場合は重複させない | `gen_ai.usage.output_tokens`。詳細 bucket は convention に従う | `completion_tokens` |
| cost | conductor の取得済み実課金のみ | `cost_details` の usage type ごとの金額、または model 定義から推定 | token 数とは別の情報 | `cost` / `costUSD` 等。フィールドは API による |

### 8.1 包括値と排他的バケット

ensemble の集計モデルと Langfuse の `usage_details` は、input と cache の各値を重ならない bucket として扱う考え方です。Langfuse では `input` は cache 系の `input_*` を除いた値で、`total` は bucket の合計です。異なる料金単価を bucket ごとに掛けて足せる一方、重複値を入れると推定 cost も二重計上になります。[Langfuse: Token & Cost Tracking](https://langfuse.com/docs/observability/features/token-and-cost-tracking)

OpenTelemetry GenAI の `gen_ai.usage.input_tokens` は cached tokens を含む input 全体であり、cache read / write 属性はその内数です。したがって ensemble の `inputTokens` を OTel の `input_tokens` に無変換でコピーしてはいけません。ensemble の排他的な値として確かめられる場合は、`input_tokens` に `inputTokens + cacheReadTokens + cacheWriteTokens` を入れ、cache read / write の属性にも各内訳を記録します。source が包括値を返す場合は先に重複しない形へ正規化します。[OpenTelemetry GenAI spans](https://github.com/open-telemetry/semantic-conventions-genai/blob/main/docs/gen-ai/gen-ai-spans.md)

Langfuse の flat `usage_details` に出す場合は、入力がすでに排他的であることを確認して `input` と cache read / write の usage type に分けます（例: `input_cached_tokens`）。OpenAI 互換 schema や OTel schema を使う場合の自動正規化は、受け付ける key と schema に依存します。cost を付ける場合も、token bucket と対応する単価を使います。[Langfuse: Token & Cost Tracking](https://langfuse.com/docs/observability/features/token-and-cost-tracking)

Helicone の request 表現は `prompt_*`、`prompt_cache_*`、cost の項目を持ちますが、これらの名前だけでは `prompt_tokens` が cache を含むかは決まりません。使う provider / endpoint の schema に照らして変換し、cache 内訳を prompt 全体へ二重加算しないようにします。[HeliconeRequest schema](https://apis.io/schemas/helicone/helicone-heliconerequest/)

worker の `estimated` usage は、外部へ出す場合も `estimated` として識別できる参考値のまま扱います。実測 token 数、cache 指標、課金根拠と合算しません。現行 harness のセッション合計が推定値を含みうる点は §3.3 のとおりです。

### 8.2 集計単位

Langfuse の generation / embedding observation、OpenTelemetry の span、Helicone の request は、原則として 1 回のモデル実行の記録です。一方、ensemble の `SessionUsageRound` は harness が usage を記録した conductor / worker の 1 ラウンドで、`get_usage` は直近ラウンド、`sessionUsage` はそのセッション内のラウンドを集計した値です。比較・export 時は同じ粒度にそろえ、セッション合計を 1 リクエストとして扱わないでください。

### 8.3 exporter の範囲

現在の終了 JSON は `sessionUsage` をそのまま含み、Langfuse、OpenTelemetry、Helicone への exporter は実装していません。将来追加する場合は、この節の field mapping と source / 集計単位を適用し、包括・排他の変換を exporter 層で明示します。

## 9. 表示とexportの整形

### 9.1 TTY 終了サマリ

TTY は記録済み usage を読みやすく確認する表示です。agent ごとに 1 行へまとめ、表記は次のとおりです。

| 条件 | 表示 |
|------|------|
| cache 値なし | `input N · output N` |
| cache 値あり | `新規 input N · output N · cache read N · cache write N`（取得できた項目のみ） |
| hit rate 算出可 | agent 行の末尾に `hit N%` |
| worker usage が推定 | worker 行の末尾に `推定` |

cache 値がある場合も `新規 input` は backend から記録された `inputTokens` の表示名であり、TTY が cache counter を差し引いて計算し直すものではありません。実際の包括・排他の意味は §3.3 と §8 を参照してください。

最後の `合計` は `totals.tokens` の `inputTokens` / `outputTokens` だけを表示し、cache や hit rate の全体行は出しません。現在の tracker の合計には完了 worker の `estimated` usage が含まれる場合があります。estimated を実測値や課金値として解釈しないよう、該当する worker 行には `推定` を付けます。compaction は agent usage 行や token 合計へ混ぜず、`コンテキスト圧縮: N 回` の独立行にします。

token usage 行があるときは、その行群の後に「記録分のみ。失敗などで未記録の usage は含みません。」という短い脚注を表示します。課金行は取得できた conductor 実課金のみで、worker 分を含むセッション全体の金額とは扱いません。該当 cost がないときは表示しません。

```text
usage（記録済み）:
  conductor: 新規 input 2k · output 600 · cache read 400 · cache write 20 · hit 20%
  worker implementer: 新規 input 500 · output 120 · cache read 100 · cache write 0 · hit 33.3% · 推定
  worker reviewer: input 300 · output 200
  合計: input 3k · output 920
  ※ 記録分のみ。失敗などで未記録の usage は含みません。
コンテキスト圧縮: 2 回
```

### 9.2 終了 JSON と export

終了 JSON は TTY の表示用ラベル・丸め・脚注を適用せず、`sessionUsage` の構造化された値を保持します。JSON 利用者は `tokenScope`、agent / total の counters、`cacheStats`、`compactionCount`、cost scope といった field を個別に解釈してください。外部ツールへ転送する場合の bucket 変換は §8 の規則に従います。現行 JSON の型と出力先は [session-metrics.md §3](session-metrics.md#3-llm-usagesessionusagetracker) を参照してください。

### 9.3 将来の exporter

Langfuse / OpenTelemetry / Helicone 向けの exporter を実装する場合も、TTY の日本語ラベルを wire format として使わず、元の structured field と `usage.source` を基に変換します。包括値か排他値かを確認できない値は、推測で合算・差し引きせず、その source のまま保持します。exporter 自体は現行スコープに含みません。
