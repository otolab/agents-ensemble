# LLM usage の意味論

> **正本:** conductor / worker が報告する LLM usage の意味と、harness が集計・表示するときの解釈。項目の型・出力先は [session-metrics.md](session-metrics.md) を参照。

## 1. まず押さえること

`ensemble issue` の token usage は、backend から受け取った値、または worker のテキストから推定した値をラウンド単位で記録したものです。すべての backend で同じ tokenizer・計上範囲・課金単位にそろえた値ではなく、provider の請求明細でもありません。

| 項目 | この文書での意味 |
|------|------------------|
| `inputTokens` | backend が input / prompt として報告した件数。cache 分を含むかは usage source による |
| `outputTokens` | backend が output / response として報告した件数。reasoning token の扱いは backend による |
| `cacheReadTokens` | backend が cache から読んだ input として報告した件数 |
| `cacheWriteTokens` | backend が cache に書いた input として報告した件数 |
| `totalTokens` | backend が返した total。テキスト推定の場合は推定 input と推定 output の和 |
| `reasoningTokens` | backend が分離して報告した reasoning 件数。Pi では `output` の内数 |

cache read / write は input を別の料金区分で数えた値の場合があります。`inputTokens` に含まれるか、別枠かは一律ではありません。backend の返却値を確認せずに `inputTokens + cacheReadTokens + cacheWriteTokens` を独自の総 input として扱わないでください。`totalTokens` も別 backend の値と直接比較できる共通の請求単位ではありません。

## 2. usage source ごとの値

`get_usage` の各ラウンドには `usage.source` が付きます。`sdk` は conductor backend が報告した値、`acp` は worker の ACP prompt 応答に含まれた値、`estimated` は ACP usage が無い worker のテキスト推定値です。

| source | input / output | cache / reasoning | 留意点 |
|--------|----------------|-------------------|--------|
| Cursor SDK (`sdk`) | `@cursor/sdk` の `TokenUsage.inputTokens` / `outputTokens` を記録 | `cacheReadTokens` / `cacheWriteTokens` / `reasoningTokens` があれば記録 | SDK が返す各項目をそのまま使う。SDK の `getUsage()` が返す課金値は §3 を参照 |
| Pi (`sdk`) | `AssistantMessage.usage.input` / `output` を `inputTokens` / `outputTokens` に写す | `cacheRead` / `cacheWrite` と、あれば `reasoning` を写す。Pi の `reasoning` は `output` の内数 | Pi は複数 provider の API を扱うため、実際の計上範囲は provider による。`usage.cost` はモデル定義の単価からの計算値 |
| ACP worker (`acp`) | 本リポジトリが `session/prompt` 応答の `usage.inputTokens` / `outputTokens` として受け取った値 | 応答に `cacheReadTokens` / `cacheWriteTokens` / `reasoningTokens` があれば記録 | ACP preset / agent ごとに報告の有無と意味を確認する必要がある。共通の ACP usage 契約としては扱わない |
| worker テキスト推定 (`estimated`) | prompt と応答テキストそれぞれの UTF‑8 byte 数を 4 で割って切り上げる | cache / reasoning は推定しない | model tokenizer を使わない粗い近似。provider が数えた token 数や課金量ではない |

Cursor SDK は `inputTokens`、`outputTokens`、cache read / write、`totalTokens` を usage として公開します。Pi の `Usage` 型も同様の区分を持ちますが、対応する API や provider は一つではありません。したがって、同じ項目名でも provider をまたいだ意味の同一性は保証されません。[Cursor SDK usage](https://cursor.com/docs/sdk/typescript)、[Pi `Usage` 型 v1.2.0](https://github.com/earendil-works/pi/blob/v1.2.0/packages/ai/src/types.ts)

ACP worker の `usage` は `session/prompt` 応答に任意で含まれるデータとして本リポジトリが読み取ります。usage が無い応答は、harness が prompt と応答テキストから推定します。ACP v1 の公式 schema は token usage / cache 計上を共通フィールドとして定義していないため、preset ごとの報告値を provider の usage 定義と照らして読む必要があります（[ACP v1 schema](https://github.com/agentclientprotocol/agent-client-protocol/blob/main/schema/v1/schema.json)、実装上の型は `packages/core/src/acp/types.ts`）。

推定値は [estimateTokenUsageFromText](../packages/core/src/usage/estimate-token-usage.ts) が UTF‑8 byte 数から計算します。モデル tokenizer を使わず、画像などの非テキスト入力、内部 tool call、provider が追加する prompt 要素、非表示の reasoning も数えません。完了せず usage が記録されなかった worker ラウンドは、このテキスト推定にも含まれません。

## 3. harness 集計の読み方

`SessionUsageTracker` は usage を記録できた conductor / worker ラウンドごとに各カウンターを加算します。セッションサマリの `tokenScope: 'recorded-usage-only'` は、セッション中の全消費を保証しないという意味です。

- SDK がまとめて返したラウンド値、ACP の報告値、worker テキストからの推定値が同じ合計に入ることがあります。source 別の小計ではありません。
- worker が ACP usage を返さない正常完了ラウンドはテキスト推定を含みます。失敗などで usage ラウンド自体が残らない消費分は含みません。
- `totals` / `byAgent` は各 source の `inputTokens`、`outputTokens`、`totalTokens`、cache counters を別々に加算します。`totalTokens` を `inputTokens + outputTokens` から再計算したり、cache counters を足して請求上の total を作ったりはしません。
- cache stats は cache counter を報告したラウンドだけから算出します。worker に cache 値が無ければ、`cacheStats.totals` は実質 conductor の cache 値だけという場合があります。「全体」は全 agent の cache を網羅した値ではありません。
- 現行の `cacheHitRate` は `cacheReadTokens` を報告したラウンドに限り、`sum(cacheReadTokens) / sum(inputTokens + cacheReadTokens)` で計算します。cache write は式に入りません。input が cache read と重ならないことを前提にした harness 内の比率であり、provider 共通の hit rate ではありません。たとえば Anthropic の prompt caching では `input_tokens` は cache read 分を含まないため、この区別が数値に表れます。100% は計算対象の cache read が `inputTokens + cacheReadTokens` の全量を占めたことを示しますが、cache 値を報告した一部 agent / round の結果であり、全 agent の全 input が cache hit したことを示すとは限りません。
- `context.percent` は全ラウンドの `inputTokens` 累計を、指定された context limit と比較した値です。現在の prompt が context window の何割を占めるかではなく、同じ会話履歴の再送や cache read もラウンドごとの値に従います。上限が不明なら percentage は出ず、算出値は 100% を上限として表示します。

項目ごとの型、cache rate の式、出力先については [session-metrics.md §3](session-metrics.md#3-llm-usagesessionusagetracker) を参照してください。

## 4. token 数と provider 課金は別の情報

`sessionUsage.cost` がある場合、その値は Cursor SDK から取得した conductor の課金記録です。`chargedCents` は割引などを反映した額、`rawCostCents` は割引前の額です。課金記録は遅れて反映される場合があり、セッション全体の確定額を表すものではありません。worker cost は取得・算出しないため、scope は `conductor-only` です。

Pi の `AssistantMessage.usage.cost` は Pi に設定されたモデル単価と token usage から計算されます。provider の請求記録ではないため、harness の `sessionUsage.cost` には含めません。worker は usage に model ID がなく、単価を安全に対応づけられないため、cost を表示しません。

請求額の確認には、利用した provider / gateway の usage report や請求画面を使ってください。Cursor の SDK usage / cost と、チーム管理者向け [Admin API usage reports](https://cursor.com/docs/account/teams/admin-api) は Cursor 側の確認先です。たとえば Anthropic API の prompt caching では、`input_tokens` は cache breakpoint より後の uncached input、`cache_read_input_tokens` と `cache_creation_input_tokens` は別項目です。合計 input はそれら 3 項目の和で、cache read / write には通常 input と異なる料金が適用されます。[Anthropic prompt caching: usage fields](https://platform.claude.com/docs/en/build-with-claude/prompt-caching)、[Anthropic pricing](https://platform.claude.com/docs/en/about-claude/pricing)

cost や usage を継続的に監視する場合の参考:

- [OpenTelemetry GenAI token metrics](https://github.com/open-telemetry/semantic-conventions-genai/blob/main/docs/gen-ai/gen-ai-token-metrics.md) は token usage を記録・集計するための semantic convention です。現在も development 扱いで、請求台帳ではありません。OpenTelemetry の convention では cache read / write は input token の内数として扱うため、raw backend 値を出力する前に対応づけを確認してください。
- [Langfuse token and cost tracking](https://langfuse.com/docs/observability/features/token-and-cost-tracking) は受け取った usage / cost の記録に加え、登録済みモデル単価から cost を推定できます。推定額は provider の請求額とは区別してください。

## 5. usage 値の確認先

直近ラウンドの `get_usage` は、そのラウンドの `usage.source` と token counters を返します。`get_session_usage` と終了 JSON の `sessionUsage` はセッション集計で、source を含むラウンド詳細は `latestRound` だけです。各 tool / 出力の形は [session-metrics.md](session-metrics.md) を参照してください。

## 6. TTY 表示方針メモ

TTY は usage の scope と source を読み違えにくい形で表示します。

- conductor と worker は agent ごとに行を分け、input / output を同じ行に置きます。cache read / write / hit は、その agent の cache 値がある場合だけ同じ行に表示します。
- 合計行を表示する場合は input / output の合計に限ります。cache がある agent だけの値を「全体」の cache 合計や hit rate として表示しません。
- worker の usage に推定値が含まれるときは、その worker 行にだけ「推定含む」と示します。全 worker に当てはまるような説明は出しません。
- TTY の token 数は記録できた usage の集計であることが分かる見出しにします。失敗した worker の未記録分を token 数に加えません。
- 課金額を表示する場合は conductor の実課金と明記し、worker を含む session cost と誤読されない表現にします。Pi の単価計算値や token 数からの推定額は実課金として表示しません。

表示先と現行 TTY サマリの項目は [session-metrics.md §2.4](session-metrics.md#24-tty-終了サマリ例) を参照してください。
