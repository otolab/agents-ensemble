# ADR 0086: 形式モデル（Lean 4）を dispatch フローの中間言語として導入する

- Status: proposed
- Date: 2026-11-24
- Related: [Issue #848](https://github.com/otolab/agents-ensemble/issues/848), [ADR 0072](0072-conductor-dispatch-lifecycle-and-recovery-boundary.md), [ADR 0056](0056-permission-stall-dispatch-hold.md), [ADR 0038](0038-operator-agent-conversation-report-hold.md), [ADR 0082](0082-operator-watch-acknowledgement-retry.md)

## Context

conductor / operator-agent のメッセージ dispatch は、停止・再開・エラー復帰が不安定である。過去に次の Issue で個別に対処し、いずれも closed になっている。

- [#650](https://github.com/otolab/agents-ensemble/issues/650): conductor 再接続成功後に dispatch が再開せず idle のまま止まる
- [#639](https://github.com/otolab/agents-ensemble/issues/639): dispatch hold 中に permission.stall / permission.pending が conductor へ届かない可能性
- [#668](https://github.com/otolab/agents-ensemble/issues/668): conductor send 最終失敗時の入力確認と再試行境界

それでも、reconnect 時の再開がうまくいかないケースが現在も残っている（利用者の報告による。再現手順を特定した Issue は、本 ADR の起草時点で確認できていない）。個別の対処を重ねても不安定さが収束していないことは、個々の状態遷移を直すだけでは足りず、状態の組み合わせ全体に対する仕様が必要だという判断の根拠である。

### 調査を難しくしている要因

時刻に依存する挙動は、再現と検証がしにくい。dispatch queue は clock を注入できるが、watch pool や runner には `Date.now` や timer の直接利用が残る（[#839](https://github.com/otolab/agents-ensemble/issues/839)）。タイミング依存の停止や再開は、実時間のテストでは再現が不安定で、不具合の原因を切り分けにくい。形式モデルは時刻を明示的な入力として扱えるため、この種の挙動を決定的に検査できる。

### 関連する open の Issue

次の Issue は、dispatch の停止・再開の不具合そのものを扱うものではない。同じ operator-agent の dispatch 周辺にあり、構造整理や並行性に関わる。

- [#759](https://github.com/otolab/agents-ensemble/issues/759): UDS poll の lock 保持で ready report の dispatch が遅れる（lock 範囲の変更）
- [#807](https://github.com/otolab/agents-ensemble/issues/807): 同一 session の同時再開による状態更新の競合（本 ADR §7 の適用範囲外）
- [#808](https://github.com/otolab/agents-ensemble/issues/808): operator-agent の src の構造整理（watch-pool の分解、時刻の注入、テスト基盤）
- [#839](https://github.com/otolab/agents-ensemble/issues/839): watch と runner の時計注入境界の整理
- [#847](https://github.com/otolab/agents-ensemble/issues/847): watch pool orchestration の責務境界の確認（#808 手順9の達成判定。pool の API と動作を変えない前提）

### 停止要因と解除経路の分散

dispatch を止める要因が複数の状態に分散している。

| 層 | 停止に関わる状態 |
|----|------------------|
| conductor | `ConductorDispatchLifecycle` の lease / `agentAvailable` / attention（[ADR 0072](0072-conductor-dispatch-lifecycle-and-recovery-boundary.md)）、dispatch hold と `heldEvents`（[ADR 0056](0056-permission-stall-dispatch-hold.md)）、Driver ローカル状態 |
| operator-agent | `conversationHold` / `reportHold`（[ADR 0038](0038-operator-agent-conversation-report-hold.md)）、retry と ack（[ADR 0082](0082-operator-watch-acknowledgement-retry.md)）、frozen batch、`pendingReconnects` |

解除経路も状態ごとに別である。

| 操作 | 解除する状態 |
|------|--------------|
| `/reconnect` | `agentAvailable` |
| `/recovery continue` | attention |
| `/resume-watch` | `conversationHold` |
| `set_dispatch_hold(false)` | dispatch hold |

各 ADR は個々の状態遷移を定めているが、「これらの状態の組み合わせ全体として、dispatch フローが何を満たすべきか」は定義されていない。たとえば「停止状態には、ある操作列で必ず到達できる解除経路がある（行き止まりがない）」「同一 input が二重 dispatch されない」といった性質は、暗黙の期待にとどまる。

### テストの限界

既存テストは個別シナリオの列挙である（[testing-strategy.md](../testing-strategy.md)）。状態の直積や操作順序を網羅的に検査する仕組みはない。また、「テストが仕様を十分に検査しているか」を測る基準もない。シナリオを足しても、足りない領域がどこかは分からない。

### 検討した選択肢

- **テストの追加のみ**: 個別の不具合には効くが、フロー全体の仕様が定義されない問題を解決しない。カバレッジの基準も得られない。
- **TLA+ / P**: モデル検査は反例の発見が速い。一方、実行可能なオラクルとして TS 実装と差分テストにつなぐ経路が弱く、LLM が書き・人が文面だけをレビューする運用では Lean の方が証明と実行を同じ言語で扱える。ただし並行性（interleaving）の網羅では優位があり、併用の余地は残す。
- **Lean からのコード抽出**: Lean の標準コード生成先は C であり、TypeScript は出力できない。参考にした AWS Cedar も、Lean モデルを実装へ変換せず、別言語の実装と差分テストで接続する方式を採っている。

## Decision

Lean 4 の形式モデルを、dispatch フローの**中間言語**として導入する。以下を採る。

### 1. 位置づけ

Lean 4 は「**LLM が書き、人が定理の文面と日本語説明をレビューする**」中間言語とする。人が Lean を書くことは前提にしない。人のレビュー対象は、性質の文面（何を満たすべきか）、反例の日本語説明、モデルと TS の対応表である。証明本体の読解は人に求めない。

### 2. 配置

リポジトリ直下に `formal/lean/` を置く。独立した Lake パッケージとし、`packages/*` の外に置いて `package.json` は置かない（pnpm workspace に参加させない）。`formal/` は形式手法全体の置き場とし、Lean 以外の手法（TLA+ 等）を採る場合も `formal/` 配下に並べる。

### 3. 構成

```text
formal/lean/
  README.md              # LLM 向け作業規約
  lean-toolchain
  lakefile.toml
  lake-manifest.json
  Ensemble/
    Flow/Spec.lean       # フロー全体の抽象仕様と性質の文面（人がレビュー）
    AsIs/                # 現行 TS の忠実な写し
      Counterexamples.lean   # 性質が破れる反例イベント列
    ToBe/                # 再設計案と証明
    Oracle/              # 後段: 差分テスト用 JSON-lines 実行ファイル
```

- `Flow/Spec.lean` は、As-Is と To-Be が共通に満たすべき抽象仕様と性質の文面を持つ。人のレビュー対象の中心である。
- `AsIs/` は、現行 TS の状態と遷移を、再設計せず忠実にモデル化する。仕様を満たさないイベント列は `Counterexamples.lean` に具体例として残す。
- `ToBe/` は再設計案と、`Flow/Spec` の性質に対する証明を持つ。
- `Oracle/` は、イベント列を JSON-lines で受け取り状態列を返す実行ファイルとする。差分テストで使う。

### 4. 方式

AWS Cedar の verification-guided development（[論文](https://arxiv.org/abs/2407.01688)）を参考にする。

1. 実行可能な Lean モデルを書く。
2. 性質を証明する。
3. TS 実装との**差分ランダムテスト**で接続する。fast-check で生成したイベント列を Lean オラクルと TS の純粋な step 関数に流し、状態遷移を比較する。

Lean から TS へのコード生成は行わない。モデルと実装は別物として保ち、差分テストで乖離を検出する。

### 5. 規約

- mathlib には依存しない。使うのは Std / Batteries / Plausible までとする。
- `lean-toolchain` と `lake-manifest.json` を固定してコミットする。
- `sorry`、`native_decide`、標準外の公理を禁止する。`--wfail` と、lean-action の axiom-audit で検査する。
- すべての定義と定理に日本語の docstring を付ける。
- 定理の**文面**を置くファイル（`Flow/Spec.lean`）と**証明**を分離し、文面の変更を人のレビュー対象とする。
- エージェントは [lean-lsp-mcp](https://github.com/project-numina/lean-lsp-mcp) を使って作業する。

### 6. 段階

| Phase | 内容 | 判断点 |
|-------|------|--------|
| 0 | As-Is モデル（`ConductorDispatchLifecycle` + dispatch hold + operator hold を対象）と、性質の文面の合意 | **反例一覧と日本語説明が最初の成果物。ここで導入の継続を判断する** |
| 1 | To-Be の設計と証明。TS リファクタリング方針は別 ADR にする | |
| 2 | Lean オラクル化と差分テスト。CI へ組み込む（[lean-action](https://github.com/leanprover/lean-action)、`lake-package-directory: formal/lean`） | |
| 3 | 「テストのテスト」: 既存 vitest のイベントログを Lean で再生し、遷移・性質のカバレッジを集計する。Stryker のミューテーションスコアと比較する（仕様ミューテーションは [Ammann & Black](https://nvlpubs.nist.gov/nistpubs/Legacy/IR/nistir6403.pdf) を参照） | |

各 Phase の受け入れ条件と進捗は Issue を正本とする。本 ADR は段階の順序と、Phase 0 を判断点とすることだけを決める。

### 7. 適用範囲の限界

非同期 Driver 全体、lock 競合、プロセス間競合（[#759](https://github.com/otolab/agents-ensemble/issues/759)、[#807](https://github.com/otolab/agents-ensemble/issues/807)）は、純粋な step 関数への差分テストに乗らない。これらはイベントログのトレース検証で補う。interleaving の網羅が必要になった場合は、TLA+ / P の併用を別途検討する。

## Consequences

- フロー全体が満たすべき性質を、`Flow/Spec.lean` の定理の文面として明示できる。分散した停止要因と解除経路の相互作用が、反例イベント列として具体的に示される。
- 「行き止まり」や二重 dispatch のような組み合わせ起因の問題を、シナリオ列挙ではなく網羅的に検査できる。Phase 3 では、既存テストの遷移・性質カバレッジという測定基準が得られる。
- LLM が、意図と異なる定理を証明するリスクがある。証明が通っても、文面が仕様を表しているとは限らない。文面ファイルの分離と人のレビュー、および TS 実装との差分テストで緩和する。
- モデルと実装が乖離するリスクがある。差分テストとトレース検証で検出するが、差分テストの対象外（§7）は検出できない。
- ツールチェーン（elan、Lean 4）の導入コストと CI 時間が増える。Phase 2 まで CI には組み込まない。mathlib に依存しないことで、ビルド時間とキャッシュ量を抑える。
- Phase 0 の成果（反例一覧）に価値がなければ、Phase 1 以降に進まずこの ADR を `deprecated` にできる。`formal/` はリポジトリに残るが、pnpm workspace・CI・既存 package のビルドには影響しない。
- 運用規約（`formal/lean/README.md`）と CI の実体は、導入後にシステム文書へ反映する。本 ADR は判断の記録であり、現行の挙動の正本ではない。
