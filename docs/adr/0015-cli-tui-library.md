# ADR 0015: CLI TUI ライブラリ選定

- Status: accepted
- Date: 2026-08-12

## Context

Issue #54（非同期オーケストレーション向け TUI）の実装に入る前に、TUI ライブラリを 1 つに絞る。本 ADR は **調査と方針決定のみ**。画面実装・sink 改修は #54 のスコープ。

### 背景

現状の CLI（`packages/cli`）は TTY 時に readline ベースの行入力（`bindAsyncOperatorInput`）と、`SessionLogger` の 2 系統 sink（Dialogue → stdout、Harness → stderr）で動作する（[session-logging.md](../session-logging.md)）。conductor / worker が非同期に動き続ける一方、オペレータは任意タイミングで `submit` できる **非ブロッキング入力**（[operator-input.md](../operator-input.md)）が必要。

#54 コメントで合意した最小 UI（4 ペイン）:

| ペイン | 内容 | 主なイベント源 |
|--------|------|----------------|
| worker 状態 | 各 worker の run / pend | `worker.round`, `worker.failed`, `harness.worker.bootstrap.*` |
| conductor 出力 | 対話テキスト | `conductor.send`（DialogueSink 相当） |
| open question | 未回答一覧 | `getContext().openQuestions` + open question 登録 callback |
| 入力欄 | オペレータ入力 | `OperatorInputBinding.submit` |

### 制約（評価軸）

| 制約 | 意味 |
|------|------|
| **pnpm monorepo / ESM / TypeScript** | `packages/cli` に依存追加。ビルドは `tsc --build` |
| **`OperatorInputBinding`** | View はブロックしない。`submit` / `getContext` の契約を TUI でも満たす |
| **`SessionLogSink` イベント駆動** | sink 購読でペインを更新。`console.xxx` 直書きは #54 で排除予定 |
| **非 TTY / CI フォールバック** | `isOperatorInputInteractive()` が false のとき現行経路を維持: stdout は終了 JSON のみ、harness は stderr（[session-logging.md](../session-logging.md) §2） |
| **stdout / stderr 分離** | 対話と harness テレメトリを混ぜない（#44） |

### 候補

| 候補 | 最新版（調査時点） | 最終更新（npm） | 概要 |
|------|-------------------|-----------------|------|
| **Ink** | 7.1.1 | 2026-07 | React コンポーネントモデル。Yoga Flexbox レイアウト |
| **neo-blessed** | 0.2.0 | 2022-05 | blessed のフォーク。ウィジェット / 画面ダメージバッファ |
| **terminal-kit** | 3.1.4 | 2026-07 | 低レベル API + Document モデル（複数ウィジェット同時表示） |
| **OpenTUI**（参考） | 0.4.x | 2026-07 | Zig ネイティブコア + TypeScript。`@opentui/core` |

### 候補比較

| 観点 | Ink | neo-blessed | terminal-kit | OpenTUI |
|------|-----|-------------|--------------|---------|
| **メンテナンス** | ◎ 活発（週次 DL 数百万、GitHub 39k+ stars） | △ 実質停止（4 年更新なし） | ○ 活発 | ○ 活発（OpenCode 等で本番利用） |
| **TypeScript** | ◎ 本体が TS、型定義同梱 | △ JS 起源、型は `@types` または自前 | △ JS 起源、型は限定的 | ◎ TS ファースト |
| **依存の重さ** | 中（`react` peer 必須） | 大（~16k 行のレガシー実装） | 大（機能豊富） | 大（ネイティブバイナリ + オプショナル FFI） |
| **複数ペイン** | ○ `Box` Flexbox で 4 分割。スクロールは自前 windowing | ◎ `layout` / `box` ウィジェットが本命 | ◎ Document モデルの `Layout` | ○ `BoxRenderable` 等 |
| **非ブロッキング入力** | ◎ `useInput` / `ink-text-input` が stdin をイベント駆動で処理。Node イベントループを塞がない | ○ `textbox` がフォーカス管理。画面全体を blessed が握る | ○ `EditableTextBox` + `grabInput`。Document モデルでフォーカス循環 | ○ `InputRenderable` + レンダラの入力ループ |
| **イベント駆動更新** | ◎ React state ← sink 購読で再描画。宣言的 | △ ウィジェットへ `setContent` 等の命令的更新 | △ Document ウィジェットの命令的更新 | ○ レンダラツリー更新 |
| **非 TTY フォールバック** | ◎ TUI 初期化を TTY 分岐の内側に置けば、現行 sink 経路をそのまま維持可能 | ○ 同様（ただし API 呼び出し自体を分岐要） | ○ 同様 | △ レンダラ生成に TTY 前提。分岐は可能だが FFI 起動コスト |
| **monorepo / Node 互換** | ◎ 純 JS、ESM 可、追加ネイティブ依存なし | ○ 純 JS | ○ 純 JS、ncurses 非依存 | △ Node 26.4+ で `--experimental-ffi` がレンダラ生成に必要（Bun 向けが主） |
| **テスト容易性** | ○ `ink-testing-library`、コンポーネント単体テスト | △ 画面全体のモックが重い | △ 同上 | △ ネイティブ依存で CI が複雑化しやすい |

### #54 最小 UI との適合（推奨案: Ink）

Ink で 4 ペイン + 非ブロッキング入力を実現する根拠:

1. **レイアウト**: 縦方向に conductor + worker + open question、最下段に入力欄 — `Box` の `flexDirection="column"` と固定高さ子要素で構成する（Yoga Flexbox）。
2. **非ブロッキング入力**: `OperatorInputBinding` と同型の `bindTuiOperatorInput` を、入力コンポーネントの `onSubmit` で `api.submit(message)` を呼ぶ形で実装。`useInput` は stdin をリスンしつつ Driver の `waitForDispatchBatch` をブロックしない（現行 `bindAsyncOperatorInput` と同じイベントループ上の非同期モデル）。
3. **open question 常時表示**: `getContext().openQuestions` を React state に反映。登録時は既存の `notifyOperatorInputReprompt` と同様に TUI 側へ再描画トリガを渡す。
4. **worker run / pend**: `worker.round` / `worker.failed` / `harness.worker.bootstrap.*` を sink で受け、worker 名 → 状態（running / idle / failed）のマップを state 化。
5. **イベント駆動更新**: `SessionLogger.subscribe(createTuiSink(setState))` で各 `SessionLogEvent` をペイン state にマージ。Ink は差分再描画するため、高頻度の harness イベントでも terminal のフルクリアを避けやすい。

### 却下理由（簡潔）

| 候補 | 却下理由 |
|------|----------|
| **neo-blessed** | npm 最終更新 2022 年。レガシー JS 大規模コードベース。命令的ウィジェット API が `SessionLogSink` のイベントストリームと相性が悪く、型安全性・長期保守のリスクが高い |
| **terminal-kit** | Document モデルは 4 ペインに適合するが、命令的 API・限定的な TS 型のため sink 統合の見通しが Ink より劣る。機能過多で学習コストが高い。代替としては有力だが、本リポジトリの TS + イベント駆動方針には Ink がより自然 |
| **OpenTUI** | 性能・将来性は高いが、ネイティブ FFI と Node 26.4+ 実験フラグが CLI 配布・CI・pnpm monorepo に追加リスク。#54 最小 UI には過剰。将来の性能ボトルネックや全面刷新時に再検討 |

## Decision

**CLI TUI ライブラリとして [Ink](https://github.com/vadimdemedes/ink)（v7 系）を採用する**（Status: `accepted`。#94 で実装）。

### 非 TTY / CI フォールバック方針

TTY 判定は現行の `isOperatorInputInteractive()` / `isOperatorInputTty()`（`packages/cli/src/prompt-operator-input.ts`）を継続する。

| 条件 | 動作（現行維持） |
|------|------------------|
| 非 TTY かつ `ENSEMBLE_OPERATOR_MESSAGE` なし | Ink を起動しない。`createHarnessSink` のみ。stdout は終了時 SessionSummary JSON のみ |
| `ENSEMBLE_OPERATOR_MESSAGE` あり | 1 回 `submit` して終了（post-loop 待機なし） |
| TTY | Ink TUI を起動。Dialogue / Harness を TUI ペインへ集約し、stdout への逐次 `write` は行わない（終了 JSON はプロセス終了時のみ） |

`issue-command.ts` の `interactive` 分岐パターンを拡張し、TUI 経路と非 TUI 経路を **同一ファイル内で明示的に分岐**する。CI / e2e テストは非 TTY 経路のまま動作させる。

## Consequences

### 良い点

- `SessionLogSink` → React state → Ink 再描画のパイプラインが #54 の「logger 集約」と整合
- `OperatorInputBinding` 契約をそのまま TUI View として実装できる
- 純 JS 依存でネイティブビルド不要。既存 pnpm / tsc ビルドに載せやすい
- 非 TTY フォールバックは分岐追加のみで現行 CLI 互換を維持できる

### 悪い点・リスク

- `react` peer 依存が `packages/cli` に追加される（バンドルサイズ・バージョン管理）
- 長文スクロールは Ink に自動 overflow がないため、各ペインで windowing（末尾 N 行）を自前実装する必要がある
- Ink はターミナル全体を占有する。TUI 起動中は `console.error` による harness 直書きと競合するため、#54 で sink 一本化が必須
- React コンポーネントのテストは `ink-testing-library` 等の追加が必要

### #54 実装への示唆

1. **新規モジュール（案）**
   - `packages/cli/src/tui/issue-session-tui.tsx` — 4 ペイン Root コンポーネント
   - `packages/cli/src/tui/bind-tui-operator-input.tsx` — `OperatorInputBinding` 実装
   - `packages/cli/src/tui/create-tui-sink.ts` — `SessionLogSink` → state updater
2. **起動**: TTY かつ interactive のとき `render(<IssueSessionTui ... />)` を `executeIssueCommand` 内で行い、既存 `createDialogueSink` / `bindAsyncOperatorInput` の代わりに TUI 版を接続
3. **依存追加（#54）**: `ink`, `react`, `ink-text-input`（入力欄）。dev: `@types/react`, `ink-testing-library`
4. **harness ペイン**: 最小 UI では #54 合意どおり harness は別ペインに含めないが、開発時参照用に折りたたみまたは別モードで `HarnessSink` 相当を表示する余地を残す（詳細デザインは #54）
5. **終了 JSON**: TUI 終了時に Ink を unmount してから `stdout` に SessionSummary を 1 行出力（[ADR 0013](0013-process-lifecycle-vs-autonomous-loop.md) 維持）

### フォロー

- #54: 本 ADR に基づく TUI 実装と `console.xxx` 排除
- Ink 7 の React 19 peer と monorepo 全体の React バージョン方針の確認（#54 着手時）

## 関連

- Issue #54, #89
- [session-logging.md](../session-logging.md)
- [operator-input.md](../operator-input.md)
- [ADR 0013](0013-process-lifecycle-vs-autonomous-loop.md) — post-loop 待機と非 TTY 終了
