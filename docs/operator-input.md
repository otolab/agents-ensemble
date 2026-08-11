# オペレータ入力（SessionView）

ConductorSession の **View 層**契約。入力・表示はここに閉じ、オーケストレーション（Driver）とは `bindOperatorInput` で接続する。

関連: [architecture.md](architecture.md) §5、[ADR 0009](adr/0009-conductor-session-event-queue.md)、Issue #54（TUI）

## 3 層の分担

| 層 | 責務 | 主なモジュール |
|----|------|----------------|
| **SessionPolicy** | dispatch 可否・ループ終了・自律ターン数 | `session-policy.ts` |
| **SessionDriver** | イベントキュー消費・max-turns 登録・`agent.send` | `conductor-session-driver.ts` |
| **SessionView** | TTY / env / 将来 TUI からのオペレータ入力 | CLI `bindAsyncOperatorInput` 等 |

データの正本: **イベントキュー**（`SessionEventQueue`）と **OpenQuestionRegistry**。View は `submit` で `operator.message` をキューへ積むだけ。

## View 契約: `OperatorInputBinding`

`@agents-ensemble/core` が export する型（`operator-input-binding.ts`）。

```typescript
interface OperatorInputContext {
  conductorTurn: number;      // 次の send 番号（1 始まり）
  autonomousTurns: number;
  maxTurns: number;
  openQuestions: OpenQuestion[];
}

interface OperatorInputBindingApi {
  submit: (message: string) => boolean;
  getContext: () => OperatorInputContext;
}

type OperatorInputBinding = (
  api: OperatorInputBindingApi,
) => void | (() => void);
```

### `submit(message)`

- 空文字は無視（`false` を返す）
- 受け付けたら `operator.message` をイベントキューへ enqueue（`true`）
- open question への `@inq:<id> <回答>` 形式も `submitOperatorInput` が解釈する

View は **ブロックしない**。ループの待機は Driver が `waitForSendEvent` で行う。

### `getContext()`

プロンプト直前の案内（未回答 open question 一覧など）に使う。CLI では `notifyOperatorInputReprompt` 経由で TTY 表示を更新する。

### 戻り値

購読解除関数を返せる（readline close 等）。省略可。

## 実装例

| 環境 | 実装 | ファイル |
|------|------|----------|
| TTY（本番 CLI） | `bindAsyncOperatorInput` | `packages/cli/src/async-operator-input.ts` |
| 非 TTY / CI | `ENSEMBLE_OPERATOR_MESSAGE` env を 1 回 submit | 同上 |
| テスト | `createTestOperatorInputBinding` | `packages/core/src/conductor/testing/test-operator-input-binding.ts` |
| 将来 TUI (#54) | 同じ `OperatorInputBinding` を実装 | — |

## `runConductorSession` への接続

```typescript
runConductorSession({
  // ...
  bindOperatorInput: bindAsyncOperatorInput, // View
});
```

`runConductorSession`（ファサード）が View を Driver へ配線する。Driver の public API を View 実装が知る必要はない。

## Policy との境界

View が決めないこと（SessionPolicy / Driver の責務）:

- max-turns 到達後に worker イベントを送るか
- 未回答 open question があるときの dispatch 優先度
- ループ終了条件

View は `getContext()` で状態を**読む**だけ。dispatch 判断は Driver が Policy を参照して行う。
