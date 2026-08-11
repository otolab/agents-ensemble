# ADR 0008: 人間対話ログと open question 管理

- Status: accepted
- Date: 2026-08-08
- Related: [ADR 0007](0007-permission-pipeline.md)

## Context

許可パイプライン（ADR 0007）では人間への出口を conductor の `ask_human` に統一した。当初の実装は `ask_human` が TTY / env で **ブロックし、tool 戻り値として回答を返す** 形だった。

一方、次の要件が明確になった。

1. **ユーザは conductor だけと話す** — オペレータの判断は次のオペレータ入力（メッセージ）として届く。tool 戻り値を正本にしない。
2. **`ask_human` は質問の登録のみ** — conductor は回答を待たず続行できる。
3. **汎用 Q&A** — permission 専用キューではなく、TODO リストに近い open question。worker が落ちてもユーザ判断は残る。
4. **prompt cache を壊さない** — open question 一覧を毎ターン system prompt に載せない（キャッシュが効かなくなる）。

## Decision

### Conductor の prompt 配信（modular-prompt と `agent.send`）

**意図した分担**（[architecture.md](../architecture.md) §3）:

| レイヤ | 役割 | 備考 |
|--------|------|------|
| **modular-prompt (`@modular-prompt/core`)** | conductor の **system prompt 文**を組み立てる | instructions / persona / guidelines / materials。`compile` の対象はここまで |
| **`agent.send(message)`** | 会話への **user ターン 1 本**を追加して run する | オペレータ発話・自律ターンの状態通知など。引数は user メッセージであり CompiledPrompt 全体ではない |
| **SDK 会話** | LLM から見た **会話履歴の正本** | assistant / tool 結果も含む |

**やってはいけないこと**（現実装の負債）:

- 毎ターン `buildConductorFollowUpPrompt` で Issue / worker 状態 / オペレータ入力をまとめて compile し、1 本の文字列として `agent.send` する
- オペレータ発話を modular-prompt の `inputs` に載せる（会話は `messages` / `agent.send` の関心事）

worker（ACP）とは別モデル。worker は `session/prompt` でターン更新全体を渡す。conductor（SDK）は **`send` = user 行の append**。

### レイヤー分担（open question・オペレータ）

| レイヤ | 役割 |
|--------|------|
| **オペレータメッセージ** | `agent.send` に載る user ターン（CLI `bindOperatorInput` / `operator.message` キュー経由） |
| **OpenQuestionRegistry** | TODO リスト的な未回答 / 回答済み状態（tool で読む） |
| **list / get tools** | conductor が必要なときだけ open question を読む |
| **SDK 会話** | LLM 会話履歴の正本（オペレータ発話・tool 結果を含む） |

### open question（TODO リストモデル）

- **一覧**: `list_open_questions`（status: open / answered / all）
- **詳細**: `get_open_question`（id 指定）
- prompt `state` には **載せない**

### `ask_human`

- **非ブロッキング** — registry に enqueue。tool 戻り値に登録報告を含める。
- オペレータがチャットですでに答えている場合は使わない → `answer_open_question`

### `answer_open_question`

- conductor がオペレータの代わりに回答を registry へ記録。
- tool 戻り値に回答報告を含める。

### オペレータ回答（チャット）

- オペレータ回答は `bindOperatorInput` で `submitOperatorInput` し、`operator.message` としてキューへ積む。
- `applyOperatorMessage` で registry を更新したあと、**その内容を `agent.send` の user メッセージとして送る**（例: 生文、または `【open question 回答】inq-1: …`）。
- 自由チャットのみ、registry の質問への回答のみ、どちらも可。

### system prompt と会話の載せ方

- **system prompt**（modular-prompt）: セッション開始時（または明示的 reload 時）に compile。指揮方針・materials・Issue の読み方。
- **会話**（`agent.send`）: オペレータ発話・自律ターンの短い通知。open question 一覧の毎ターン全件投影はしない。
- 変化の多い状態（worker 完了、pending permission）は **自律ターンの user メッセージ** または tool 結果として届ける（詳細は実装 Issue で設計）。

### issue session ループと `maxTurns`

- `maxTurns` は **直近オペレータ入力からの conductor 自律ターン上限**（オペレータ入力でリセット）。
- ループ終了条件（`shouldStopIssueLoop`）:
  - `lastStatus === 'error'` → 終了
  - 実行中 worker、判断待ち permission、未回答 open question あり → 継続
  - 当ターンの worker dispatch / failure がなく `lastStatus === 'finished'` → 終了
  - それ以外 → 継続
- 自律ターン上限到達時:
  - orchestrator が open question「次どうする？」（`source: max_turns`）を **自動登録**
  - オペレータは `bindOperatorInput` 経由で回答（`operator.message`）
  - 旧 `escalateOnMaxTurns` / ブロッキング `onHumanInquiry` / ボーナスターンは廃止
- open question が未回答のときは自律 worker イベントを抑止し、`operator.message` を優先 dispatch（[ADR 0009](0009-conductor-session-event-queue.md)、`canDispatchConductorSend`）

## Consequences

- 良い: prompt cache を維持しやすい。TODO リスト的に必要時だけ読める。ユーザ判断が worker 生死と独立して残る
- 悪い: conductor が `list_open_questions` を呼ばないと未回答を見落としうる（guidelines で矯正）
- フォロー: 外向きオペレータ UI、open question registry の resume 永続化（#27）、**ConductorSession イベント列と prompt 配信**（#28、[ADR 0009](0009-conductor-session-event-queue.md)）
