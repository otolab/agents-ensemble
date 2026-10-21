# Issue #520 調査報告: codex-acp usage

> エージェントによる調査報告（implementer）。調査日: 2026-10-21
> 対象: [Issue #520](https://github.com/otolab/agents-ensemble/issues/520)
> 実装変更は行っていない。

## 結論

- npm の `latest` と GitHub の最新 stable release は **`@agentclientprotocol/codex-acp` 2.2.2**（確認時点）。npm の `preview` tag は `2.2.3-preview.21`。ensemble は 1.6.2 を pin し、同版は Codex CLI `^0.148.0` を依存に持つ。2.2.2 は `^0.160.1` を使う。
- 上流 2.2.2 では、1.6.2 の「prompt 内最後の model request だけを返す」不足と cache write 欠落がコード上修正され、prompt 単位の複数 request usage と fresh input / cache read / cache write を出す。ただし Codex 側が観測した token usage の報告であり、provider の請求額や全 Codex activity の台帳ではない。
- ensemble にも別の欠落がある。ACP wire の `cachedReadTokens` / `cachedWriteTokens` / `thoughtTokens` と、harness の `LlmUsageSnapshot` / `fromAcpUsage` が読む `cacheReadTokens` / `cacheWriteTokens` / `reasoningTokens` が一致しない。`acp-client.ts` は応答をそのまま型アサーションしているため、cache と reasoning は worker usage に取り込まれない。codex-acp の bump だけでは cache 列は埋まらない。
- **推奨は一つ:** 次の ensemble 実装作業で ACP wire field を内部 usage 型へ明示変換し、codex-acp を 2.2.2 に上げ、Codex worker の ACP v1 実機スモークで複数 request / cache の受け渡しを確認する。`SessionUsageTracker` の合算規則は変えない。上流 Issue #447 に同じ修正を求める新規報告は現時点で不要。

## 1. pin と最新版の差分

| | ensemble の pin | npm / GitHub stable |
|---|---|---|
| codex-acp | 1.6.2 | 2.2.2 |
| Codex CLI dependency | `^0.148.0`（lockfile 解決 0.148.0） | `^0.160.1` |
| release | 2026-08-19 | 2026-10-10 |

1.6.2 から 2.2.2 の release notes には多数の機能・不具合修正がある。usage について特に意味がある差は changelog の一行だけではなく、tag の実装比較で確認した。

- **1.6.2:** `TokenCount.ts` は Codex input から cache read のみを引き、ACP `cachedReadTokens` に写す。`cacheWriteInputTokens` は TokenCount の正規化型・変換・ACP response には出ない。`CodexAcpServer.ts` は `lastTokenUsage` を `PromptResponse.usage` に渡す。tool call loop を含む prompt でも最後の request しか表さない。
- **2.2.2:** `TokenCount.ts` は `cacheRead` と `cacheWrite` の両方を Codex input から引き、排他的な fresh input に分けて、ACP の `cachedReadTokens` / `cachedWriteTokens` に出す。reasoning は `thoughtTokens` として出す（`outputTokens` の内数）。`PromptTokenUsage` は thread total の prompt 開始・終了差分を使い、prompt 中の複数 request を扱う。total が不明な場合などは観測した per-request `last` 値の合算へ fallback する。
- 1.6.2 以降 changelog の **1.9.0「report complete status usage and limits」**は `/status` の usage / limits 報告の変更で、prompt の全 request 合算ではない。prompt accounting の不足は上流 [Issue #447](https://github.com/agentclientprotocol/codex-acp/issues/447) に記録され、[PR #486](https://github.com/agentclientprotocol/codex-acp/pull/486) も公開されている。PR 自体は確認時点で open だが、2.2.2 tag の実装には prompt accumulator が存在する。PR の方式・状態と release tag の実装を同一視しないこと。
- **2.0.0 は明示的な breaking release。** release note が挙げるのは AIR 向け tool-call contract / exact diff patch 等。README は AIR 以外の client は従来の field を保つとしている。ensemble は通常 ACP client として利用しており、当該 AIR 専用契約が直ちに ensemble の wire に当たる証拠は見つからなかったが、2.x 全体の互換性はスモーク確認が必要。
- spawn env は README の現行・1.6.2 の runtime option とも `INITIAL_AGENT_MODE` を掲載。ensemble が渡す `agent` は両版で有効で、現行コードでも workspace-write + on-request approval に対応する。env 名や mode ID の破壊的変更は確認できなかった。`CODEX_CONFIG` は JSON、`MODEL_PROVIDER` は新規 session の provider ID、`CODEX_PATH` は bundled Codex の上書きとして引き続き文書化されている。
- Codex CLI 依存は 0.148.0 から 0.160.1 に上がる。`CODEX_PATH` で別 CLI を指定すると adapter に同梱された版と異なる可能性があるため、実環境ではその構成も互換性の条件になる。

参照: [npm package / versions](https://www.npmjs.com/package/@agentclientprotocol/codex-acp?activeTab=versions), [v2.2.2 release](https://github.com/agentclientprotocol/codex-acp/releases/tag/v2.2.2), [v2.2.2 changelog](https://github.com/agentclientprotocol/codex-acp/blob/v2.2.2/CHANGELOG.md), [v1.6.2 TokenCount](https://github.com/agentclientprotocol/codex-acp/blob/v1.6.2/src/TokenCount.ts), [v2.2.2 TokenCount](https://github.com/agentclientprotocol/codex-acp/blob/v2.2.2/src/TokenCount.ts), [v1.6.2 AgentMode](https://github.com/agentclientprotocol/codex-acp/blob/v1.6.2/src/AgentMode.ts), [v2.2.2 AgentMode](https://github.com/agentclientprotocol/codex-acp/blob/v2.2.2/src/AgentMode.ts), [v1.6.2 README](https://github.com/agentclientprotocol/codex-acp/blob/v1.6.2/README.md), [v2.2.2 README](https://github.com/agentclientprotocol/codex-acp/blob/v2.2.2/README.md).

## 2. `session/prompt` usage の実態

### wire fields と意味

ACP response の `usage` は任意。codex-acp 2.2.2 は次を出す。

| ACP wire field | codex-acp の意味 |
|---|---|
| `inputTokens` | cache read / cache write のどちらでもない fresh input |
| `cachedReadTokens` | prompt cache から読んだ input |
| `cachedWriteTokens` | prompt cache へ書いた input |
| `outputTokens` | output 全体。reasoning output を含む |
| `thoughtTokens` | reasoning output。`outputTokens` の内数 |
| `totalTokens` | Codex app-server が報告した total。component を再加算して作らない |

Codex 側の cache write は provider が `cacheWriteInputTokens` を報告する場合に限られる（上流実装コメントでは Anthropic 等。その他は通常 0）。model/provider の組合せを変えた実測はしていない。cache read/write が 0 の場合も、その値が明示される場合と usage 自体が無い場合があり、全 model で必ず非 null とは確認できない。

2.2.2 の prompt 集計は「session 累積」ではなく、Codex app-server の thread usage 更新からその prompt の増分を組み立てる。従って、一つの ACP prompt が複数の model request を行えば、認識できた request の usage を含む。既存履歴の baseline 不明・counter の後退などでは別経路の合算を使い得るため、完全性の保証ではない。別 native subagent thread 等は親 prompt の根拠に含めない。上流 adapter は `_meta.quota.token_count` に同じ prompt usage を載せ、model 名別配列も付けるが、model 名への割当てに FIXME がある。そこに dollar cost / provider 請求額はない。

ACP v1 schema には `PromptResponse` の「この turn」と Usage fields の「session / all turns」表現が併存する曖昧さがあり、[ACP Issue #1860](https://github.com/agentclientprotocol/agent-client-protocol/issues/1860) で議論中。2.2.2 adapter の意図する粒度は prompt ごとの増分だが、ACP の全実装に通用する累積方式ではない。

### 実測 sample と取得記録（秘匿情報を除去）

この sample は、conductor が permission 審査後に実行した実測 Node probe の記録に基づく。codex-acp **1.6.2** を `INITIAL_AGENT_MODE=read-only` で起動し、ACP `initialize`（protocol version 1）→ `session/new` → `session/prompt` の順に実行した。prompt は `Reply only with OK. Do not use tools.`。

probe は JSON-RPC result を `r` とし、ログ wrapper で `usage: r.usage` をそのまま出力した。下記は実測 result からの `usage` subtree の抜粋であり、キー・値は取得記録どおり。応答全体の原文ではない。wrapper が別途付加した `agentVersion: "1.6.2"` は計測環境情報であり、wrapper の `meta` は `r._meta` を表示用に改名したもの。完全な raw JSON-RPC envelope は保存されていない。

session ID、作業ディレクトリ、prompt 以外の会話内容、認証情報は掲載しない。model 識別子は報告書に含めない。command line 全文や生の permission 記録は conductor から共有されていないため、ここでは補っていない。

```json
{
  "totalTokens": 11432,
  "inputTokens": 11427,
  "cachedReadTokens": 0,
  "outputTokens": 5,
  "thoughtTokens": 0
}
```

これは 1.6.2 の single prompt 実測で、cache hit/write が起きる条件や複数 request の過少計上を測ったものではない。複数 request の問題と修正は [上流 PR #486 の記載](https://github.com/agentclientprotocol/codex-acp/pull/486)にも実測例があり、Codex 0.153.3 で各 prompt の二回の model request を比較している。ただし同 PR は open の提案記録であり、この報告では再実測していない。2.2.2 の実機で cache read/write を発生させた比較は未確認。

## 3. ensemble との接続・表示差

ローカル実装では `acp-client.ts` が JSON-RPC result を `PromptResult` に型アサーションして返すだけで、wire field の rename / normalization はない。一方 `LlmUsageSnapshot` は `reasoningTokens`, `cacheReadTokens`, `cacheWriteTokens` を宣言し、`fromAcpUsage` も同名プロパティのみを読み取る。wire の `thoughtTokens`, `cachedReadTokens`, `cachedWriteTokens` は未知 property のまま捨てられる。したがって現 pin で実測 sample の `inputTokens` / `outputTokens` / `totalTokens` は取り込まれるが、`cacheReadTokens` は 0 でも記録されず、`thoughtTokens` も `reasoningTokens` に移らない。cache write は wire 上も存在しない 1.6.2 から、現行境界では引き続き見えない。

tracker 自体は `fromAcpUsage` で ACP round の input / output を記録し、`totalTokens` が無ければその和を使う。存在する値を別 request ごとに再分割したり、token bucket を正規化したりしない。usage が無い完了 worker のみ prompt / 応答文 UTF‑8 byte 数÷4の `estimated` fallback となり、cache / reasoning は推定しない。失敗して round が残らない消費も対象外。

`token-usage-semantics.md` が説明するのは **harness 内部で正規化済みの LlmUsageRecord の意味**であり、ACP wire と内部型の変換が正しく行われている保証ではない。

- semantics §2 は source ごとの値、§3.1–3.3 は round 集計・排他的 bucket、§4 は token と請求額の境界、§9.1 は TTY 表示を定義している。Issue にある「semantics §2.1 / §2.3 / §4.3」という小見出しは、現 checkout の当該文書には存在しない。参照先は上記の番号へ読み替える必要がある。
- TTY は agent 行に cache 値があれば cache 列を出し、なければ `input` / `output` のみを出す。合計行は仕様上 input / output のみで、cache bucket を含めない。従って conductor の cache 列が出て Codex worker に出ないことは、表示ロジックだけでなく adapter wire mapping の欠落でも起きる。
- codex-acp 1.6.2 の `inputTokens` は cache read を除いた値（cache write は分離されず input に残る）。2.2.2 では read/write 両方を除いた fresh input になる。よって conductor の input と worker の input を、cache 列や source を見ずに比べると定義差が混ざる。`conductor cache read 1.1M` 対 `worker input 17k` のような桁差だけでは harness の足し算バグとは断定できない。1.6.2 の最後 request のみという不足、worker cache の mapping 欠落、conductor SDK とは異なる source・request 粒度が重なるためである。
- 課金額は別。現行 semantics でも `sessionUsage.cost` は conductor の取得済み請求情報のみで worker cost を含まない。codex-acp の token / `_meta.quota` は Codex が報告する token count で、provider API の請求台帳や model 単価を伴わない。
- `get_usage` は `source: acp` の harness 正規化後 round を返すもので、生 JSON-RPC response ではない。現在の `acp-client.ts` に raw usage を記録する処理はなく、通常の harness usage 出力だけから wire field 名を確認できない。生値が必要なら JSON-RPC stdout trace または一時的な受信点 instrumentation が必要。

## 4. 「API のべ量」に足りないもの

API call ごとの provider usage / 課金量を ensemble に積むには、少なくとも次が不足している。

- 現 pin は最後の model request しか返さず、prompt 内の複数 request を合算しない。2.2.2 では prompt-scoped aggregate があるが、観測できない・別 thread の model calls を含む保証はない。
- ensemble は ACP wire の cache read / write / reasoning 名を内部フィールドへ変換していないため、上流が field を送っても現状取り込めない。
- `PromptResponse.usage` は provider API call ごとの明細・request ID ではなく adapter が集約した値。Codex CLI / provider が返さない token breakdown、model-specific price、currency、actual charged cost は復元できない。`_meta.quota` も pricing / billing record ではない。
- ACP usage 粒度の仕様自体に per-turn / session-cumulative の曖昧さがあり、adapter の version / semantics を知らずに汎用的に合算・差分できない。

実際の API 請求額が必要なら provider / gateway の usage report と突合する別設計が要る。今回の推奨作業は token usage の取得・bucket 表示までであり、課金照合はこの Issue の範囲外。

## 5. 受け入れ条件と未確認事項

| 受け入れ条件 | 状態 | 根拠 / 制約 |
|---|---|---|
| pin と最新版の差分 | 達成 | npm/GitHub stable 2.2.2、Codex dependency 0.148.0 → 0.160.1、usage/cache 差分、2.0 breaking / spawn env を記載 |
| 実測 session/prompt usage sample 1件以上 | 達成 | 1.6.2 の実測 JSON-RPC response を秘匿情報除去後に掲載 |
| API のべ量のため codex 側に足りないもの | 達成 | 複数 request scope、別 thread / unobserved calls、billing fields の不足を列挙 |
| 次の推奨を一つに絞る | 達成 | ensemble adapter field normalization + 2.2.2 bump を同じ follow-up にまとめる |

未確認:

- 2.2.2 の複数 request / cache read / cache write を、この worktree から実機で再測定していない。1.6.2 の single prompt sample のみ掲載。
- Codex CLI `CODEX_PATH` override、各 provider / model の cache write 実値と、2.2.2 の ACP v1 ensemble integration compatibility は未検証。
- 調査時の `gh auth status` は `otolab` token invalid を返し、Issue comment は投稿できなかった。報告書を PR で共有する場合も Issue への直接コメントは別途未実施として扱う。

## 参考

- [Issue #520](https://github.com/otolab/agents-ensemble/issues/520)
- [codex-acp v1.6.2 TokenCount.ts](https://github.com/agentclientprotocol/codex-acp/blob/v1.6.2/src/TokenCount.ts), [v2.2.2 TokenCount.ts](https://github.com/agentclientprotocol/codex-acp/blob/v2.2.2/src/TokenCount.ts), [v2.2.2 CodexAcpServer.ts](https://github.com/agentclientprotocol/codex-acp/blob/v2.2.2/src/CodexAcpServer.ts)
- [codex-acp Issue #447](https://github.com/agentclientprotocol/codex-acp/issues/447), [PR #486](https://github.com/agentclientprotocol/codex-acp/pull/486), [ACP Issue #1860](https://github.com/agentclientprotocol/agent-client-protocol/issues/1860)
- ensemble: [LlmUsageSnapshot](../packages/core/src/acp/types.ts), [ACP client](../packages/core/src/acp/acp-client.ts), [SessionUsageTracker](../packages/core/src/usage/session-usage-tracker.ts), [usage semantics](token-usage-semantics.md), [session metrics](session-metrics.md)
