# ADR 0087: conductor dispatch transition core と実行層の分離

- Status: accepted
- Date: 2026-11-27
- Related: [Issue #894](https://github.com/otolab/agents-ensemble/issues/894), [Issue #896](https://github.com/otolab/agents-ensemble/issues/896), [Issue #897](https://github.com/otolab/agents-ensemble/issues/897), [Issue #898](https://github.com/otolab/agents-ensemble/issues/898), [ADR 0056](0056-permission-stall-dispatch-hold.md), [ADR 0072](0072-conductor-dispatch-lifecycle-and-recovery-boundary.md), [ADR 0086](0086-lean-formal-model-for-dispatch-flow.md)

## Context

Issue #855 と Lean `Flow/Spec.lean` は、dispatch flow の抽象 state、外部 event、観測、性質を定める。一方、現行 TypeScript の queue / selector / lifecycle / recovery 状態と `runConductorSessionDriver` は、純粋な判断と Promise・timer・I/O を含む実行処理が同じ実行経路に集まっている。状態の意味を保ったまま Lean と TS の関係を明示する境界が必要である。

ADR 0086 §3 は As-Is の忠実な写し、To-Be の再設計、後段 Oracle を分け、§6 は Phase 1 の TS リファクタリング方針を別 ADR に置くとしている。本 ADR はその TS 側の構造と、Lean / TS 間で比較する範囲を定める。Issue #896 の conductor lifecycle 文書は、#897 の To-Be Lean と #898 の TS 抽出に共通する現行挙動・契約の入力となる。

現行 `Flow/Spec.lean` の `Event.schedule` と `ScheduledDispatches` は schedule 遷移内の `Observation.dispatched` を要求し、同 Spec は `dispatched` を実 send 開始として説明する。Issue #896 が求める選択 / schedule と実 send 開始の分離との対応について architect に相談した。具体実装の遷移列を抽象 `.schedule` に写す案は候補になりうるが、中断・停止・無限待機を含む全 trace と必要な公平性条件を別途検証する必要がある。現時点でその整合や同値性を証明したとは言えない。また、Issue #855 の完了コメントは operator 合意を記録する一方、`Flow/Spec.lean` 冒頭は合意前の候補と記述している。この記録差も未解決であり、どちらも Issue #896 に記録した。本 ADR と lifecycle 文書は既存記録を改変しない。

## Decision

以下を設計判断として採用する。オペレータは Open Question `inq-1` で lifecycle 契約と本 ADR に「LGTMです。」と回答し、続く `inq-2` で ADR 0087 の正式採択と `accepted` への変更に yes と回答した。この判断を受け、ADR 0087 を正式採択済みとして記録する。採択はここに記した設計方針への合意であり、Lean / TS の対応が証明済みという意味ではない。また、これは GitHub の PR review 承認を意味しない。

### 1. Transition core と実行層

- Transition core は純粋な一段関数 `step(state, event) -> (nextState, effects)` とする。
- Lean と TypeScript で構文を揃える必要はない。state の意味、step の入出力の形、各 event に対する振る舞いを対応させる。
- 非同期実行、Promise、timer、実時間 clock、listener、agent / provider API、永続化、queue / inbox I/O、TTY / UDS は実行層に置く。実行層は effect を実行し、外部結果を明示 event として core に戻す。
- `schedule(selection)` と `sendStarted(attempt)` は別の event として扱う。選択を send 開始・完了、provider の受理、tool effect の成功と同一視しない。#855 の `Observation.dispatched` は実 send 開始を指す意味のまま保つ。
- reconnect は開始要求と成功 / 失敗結果だけを core に置くモックとし、close / resume や認証・transport の内部処理はモデル化しない。

具体実装の複数遷移（選択、reservation、lease 取得、実 send 開始）を抽象 `.schedule` に対応づける案を候補とする。この対応は #855 の `Observation.dispatched` を実 send 開始として保つもので、選択時の観測に読み替える案ではない。ただし、対応関係は未証明であり、この ADR は Lean / TS の整合や trace refinement を主張しない。中断・停止・無限待機を含む全 trace がどう写るか、またその性質の検証にどの公平性条件が要るかを確認する必要がある。今回は公平性条件も #855 の性質も追加・変更しない。ADR の採択をもってこの候補を To-Be / TS の既成事実とは扱わず、対応と必要条件が検証されるまでは未証明として扱う。

### 2. 二つの core と event contract

- conductor と operator は別々の core / state owner とする。相手の mutable state を直接共有しない。
- 間は意味を定めた event contract で接続する。誰が event を生成し、どちらの state が正本か、受理・結果がどこまで確認できるかを `docs/conductor-dispatch-lifecycle.md` に記録する。
- event contract の初版は現在の SessionEvent、operator operation、send / reconnect result、operator-visible lifecycle event を対応づける。安定した wire schema、process restart を跨ぐ event ID、operator core の詳細設計はこの ADR の対象に含めない。
- abstract trace の ID はモデル内で項目を追うための識別子とし、本文一致・現在の TypeScript event ID・永続 ID を保証しない。

### 3. Lean / TypeScript の対応と検証範囲

- Lean と TypeScript で二重に記述するのは transition core の state、event、effect と純粋な step に限る。現行クラス・ファイル単位の一対一移植を目標にしない。
- As-Is Lean (`formal/lean/Ensemble/AsIs/`) は参照用に凍結する。新規 Lean の再設計は `formal/lean/Ensemble/ToBe/` に置く。
- To-Be の性質は有限探索結果で代替せず、theorem による全域証明を求める。証明が複雑になりすぎる場合は model / transition design を見直す。
- state / event trace の照合を Lean と TS の transition core の対応を調べる手段として用いる。対応関係自体は別途確立・検証が必要で、trace 照合を実施しただけで全 trace の一致を主張しない。これは非同期実行層の全順序、外部 service の結果、end-to-end delivery deadline、provider effect の exactly-once も証明しない。

### 4. 既存の意味

本 ADR は ADR 0056 の permission stall / dispatch hold の扱い、ADR 0072 の single lease / no replay / recovery confirmation / inbox 境界、Issue #855 の性質を変更しない。意味や保証を変える必要が判明した場合は、現行挙動と差分を示し、別の operator 判断と ADR が必要である。ADR 0086 は書き換えない。

## Consequences

### 良い点

- 純粋な状態遷移と async / I/O の責務を分け、Lean の型・step と TS の core を trace で照合できる。
- conductor と operator の状態所有権を分けながら、両者の handoff event の意味を共有できる。
- reconnect の抽象化を開始 / 結果に絞り、provider 内部挙動を保証と取り違えにくくする。

### リスク・制約

- 現行 TS は state を lifecycle / queue / driver / inbox / worker / permission など複数の owner に分けている。抽象 state との写像と event trace の完全性は別途確認が必要。
- 抽象 `.schedule` と concrete な選択から実 send 開始までの遷移列との対応は候補にとどまる。中断・停止・無限待機を含む全 trace と公平性条件を検証するまでは整合を主張できず、selection を `dispatched` と読み替えたり既存性質を変えたりする危険が残る。
- trace 照合は実行層の非同期 interleaving や external side effect の成否を網羅しない。結果から有限配送期限や副作用の重複排除を主張できない。
- #855 の operator 合意記録と Lean file header の差は未解決で、本 ADR の範囲ではどちらも書き換えない。ADR 0087 の採択は、本 ADR に記した設計判断への合意を示す。#855 の性質や記録を変更せず、具体遷移列と抽象 `.schedule` の対応や公平性を証明したことも意味しない。

## 参照

- [Conductor dispatch lifecycle](../conductor-dispatch-lifecycle.md) — 現行 state owner、関数対応、保証、core / execution boundary、operator event contract
- [ADR 0086](0086-lean-formal-model-for-dispatch-flow.md) §3 — As-Is / To-Be / Oracle
- [ADR 0086](0086-lean-formal-model-for-dispatch-flow.md) §6 — Phase 1 と TS リファクタリング方針
- [Issue #855](https://github.com/otolab/agents-ensemble/issues/855) — 抽象 state、event、property と operator review の記録
