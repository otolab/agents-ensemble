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
4. **prompt cache を壊さない** — open question 一覧や対話ログ全件を毎ターン prompt `state` に載せない（キャッシュが効かなくなる）。

SDK は conductor LLM の multi-turn 文脈は持つが、オーケストレーション対話の正本は ensemble 側が持つ（[architecture.md](../architecture.md) の worker 会話破棄方針と整合）。

## Decision

### レイヤー分担

| レイヤ | 役割 |
|--------|------|
| **オペレータメッセージ** | 人間の発話の正本（ACP `session/prompt` / 次 `agent.send` 相当） |
| **OpenQuestionRegistry** | TODO リスト的な未回答 / 回答済み状態 |
| **dialogue log** | セッション結果用の時系列（prompt には載せない） |
| **registry 更新の入力報告** | 更新が起きたときだけ、その差分を「入力内容」として届ける |
| **list / get tools** | conductor が必要なときだけ一覧・詳細を読む |
| **SDK 会話** | LLM 文脈用（補助） |

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

- 別ターンの `onOperatorInput` で受け取る。
- registry 更新時は **更新内容を入力メッセージとして報告**（例: `【open question 回答】inq-1: …`）。
- 自由チャットのみ、registry の質問への回答のみ、どちらも可。

### prompt への載せ方

- **毎ターンの全件投影はしない**（cache 非効率）。
- 変化があったときの **差分入力** と **tool 読み出し** で足りる。

### issue session ループと `maxTurns`

- `maxTurns` は **直近オペレータ入力からの conductor 自律ターン上限**（オペレータ入力でリセット）。
- ループ終了条件（`shouldStopIssueLoop`）:
  - `lastStatus === 'error'` → 終了
  - 実行中 worker、判断待ち permission、未回答 open question あり → 継続
  - 当ターンの worker dispatch / failure がなく `lastStatus === 'finished'` → 終了
  - それ以外 → 継続
- 自律ターン上限到達時:
  - orchestrator が open question「次どうする？」（`source: max_turns`）を **自動登録**
  - conductor には送らず `onOperatorInput` 待ち
  - 旧 `escalateOnMaxTurns` / ブロッキング `onHumanInquiry` / ボーナスターンは廃止
- open question が未回答のときは conductor を送らず、先に `onOperatorInput` で回答を集める。

## Consequences

- 良い: prompt cache を維持しやすい。TODO リスト的に必要時だけ読める。ユーザ判断が worker 生死と独立して残る
- 悪い: conductor が `list_open_questions` を呼ばないと未回答を見落としうる（guidelines で矯正）
- フォロー: 外向き `ensemble acp`、dialogue log 永続化、SDK user turn 直送は別フェーズ
