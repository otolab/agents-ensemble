# オペレータ入力（SessionView）

ConductorSession の **View 層**契約。入力・表示はここに閉じ、オーケストレーション（Driver）とは `bindOperatorInput` で接続する。

関連: [architecture.md](architecture.md) §5、[ADR 0009](adr/0009-conductor-session-event-queue.md)、[ADR 0014](adr/0014-conductor-dispatch-batch-coalescing.md)、Issue #54（TUI）

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
  maxTurns: number | null;    // 無制限時は null（表示は ∞）
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

View は **ブロックしない**。ループの待機は Driver が `waitForDispatchBatch`（内部で `selectDispatchBatch` + `SessionEventQueue.waitForEvent`）で行う。到着済みの同一メンバーイベントは [ADR 0014](adr/0014-conductor-dispatch-batch-coalescing.md) に従い 1 束にまとめてから `agent.send` する。

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

- max-turns 到達後に worker イベントを送るか（`maxTurns <= 0` のときは常に可）
- 次に送るイベント束の選び方（`operator.message` 最優先、直前メンバー 1 回優先、静的優先度 — ADR 0014）
- 未回答 open question があるときのループ継続（open question がある間は停止しない）
- ループ終了条件

## CLI: 自律ターン上限

| 条件 | デフォルト |
|------|-----------|
| TTY または `ENSEMBLE_OPERATOR_MESSAGE` あり | 無制限 |
| 非 TTY / CI | 5 |

明示指定:

```bash
ensemble issue <url> --max-turns 10   # 上限 10
ensemble issue <url> --max-turns 0    # 無制限
ensemble issue <url> --no-max-turns   # 無制限
```

無制限時は `OperatorInputContext.maxTurns` が `null` となり、TTY 表示は `自律ターン: N/∞` となる。

View は `getContext()` で状態を**読む**だけ。dispatch 判断は Driver が Policy を参照して行う。

## post-loop 待機（プロセス維持）

自律ループ停止後、CLI TTY デフォルトでは harness が **post-loop 待機** に入る（[ADR 0013](adr/0013-process-lifecycle-vs-autonomous-loop.md)）。

| 条件 | 動作 |
|------|------|
| TTY + デフォルト | 自律ループ停止後も `operator>` を維持。`/exit` でプロセス終了 |
| `--no-wait` | 自律ループ停止後に即終了（従来動作） |
| 非 TTY / CI | `waitForOperatorExit` なし → 即終了 |
| post-loop 中の追加入力 | `operator.message` としてキューに積み、SessionDriver を再実行 |

終了 JSON はプロセス終了時のみ stdout（変更なし）。
