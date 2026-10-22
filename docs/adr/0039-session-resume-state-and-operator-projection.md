# ADR 0039: Session resume 永続化と operator 投影（harness phase・到達性）

- Status: accepted
- Date: 2026-10-22
- Related: [ADR 0011](0011-session-sidecar-resume.md), [ADR 0030](0030-tty-close-lifecycle.md), [ADR 0035](0035-open-question-shutdown-commit-order.md), [ADR 0037](0037-operator-agent-session-watch-and-dispatch.md), [Issue #560](https://github.com/otolab/agents-ensemble/issues/560), [Issue #561](https://github.com/otolab/agents-ensemble/issues/561)

## Context

[ADR 0011](0011-session-sidecar-resume.md) は `{repoRoot}/.ensemble/sessions/{conductorAgentId}.json` を **sidecar** と呼び、resume に必要な harness 状態を保存する。[ADR 0030](0030-tty-close-lifecycle.md) は `/close`（再開前提の一時退室）と `/exit`（作業終了と worktree cleanup）を分けた。

運用と operator-agent 利用で次の問題がある。

1. **用語**: sidecar は一般に「メイン処理に横付きする別コンポーネント」を指し、本リポジトリの「resume 用 JSON 永続化」とずれる（[#560](https://github.com/otolab/agents-ensemble/issues/560)）。
2. **`lifecycle` フィールド**: teardown 時だけ付与される終了区分（`closed` / `exited` / `interrupted` / `unknown`）であり、**プロセスが生きているときの位相**（conductor / workers が busy か idle か）を表さない。Phase 1 では `running` を記録しない（[session-logging.md](../session-logging.md)）。
3. **利用者の問いとのずれ**: operator が知りたいのは「そのセッション instance に **何ができるか**」（見守る / 操作する / resume する / 掃除する）であり、内部 teardown のラベルだけでは不足する（[#561](https://github.com/otolab/agents-ensemble/issues/561)）。
4. **鮮度**: 「idle が 10 分でも CI 待ちなら見守りでよい」には、固定の「3 日異常」ルールより **更新時刻と人間向け一行** が足りる。harness 管理の時刻が `updatedAt`・`reportedAt`・（無い）activity で分散している。
5. **到達性**: JSON に `harnessSocketPath` があっても **稼働や live control の可否**にはならない（[architecture.md](../architecture.md)）。`exit` 保存後に probe が成功するなど、**永続化と live 観測が矛盾**しうる。

`/close` と `/exit` の product 意図は次のとおり（[ADR 0030](0030-tty-close-lifecycle.md) を補足する）。

- **`/close`**: 作業は **継続前提**。プロセスは終了するが resume 用状態を残す。
- **`/exit`**: **作業線の終了**。worktree cleanup を試みる。ACP session ID 等は **掃除判断用にメタデータを残す**（即ファイル削除ではない）。古い instance の整理では `exit` 付きを優先して片付ける想定。

## Decision

### 1. 命名（harness 永続化）

- コード・ドキュメントの正称は **SessionResumeStore**（ファイルは当面 [ADR 0011](0011-session-sidecar-resume.md) と同じ `{conductorAgentId}.json`）。
- 旧称 **sidecar** は新規文書では使わない。実装 rename は [#560](https://github.com/otolab/agents-ensemble/issues/560) で行う。

### 2. 三つのデータ面（責務分離）

| 面 | 保存場所 | 書き手 | 内容 |
|----|----------|--------|------|
| **A. Harness resume 永続化** | SessionResumeStore（JSON） | 生きている harness の flush | resume 整合性、`harnessPhase` + `modifiedAt`、worker ACP id 等 |
| **B. Operator 報告** | `session-state.yaml` | `report_session_state` | 一行 `statusLine` + `reportedAt`（意味・文脈） |
| **C. Operator 投影** | API 応答（永続ファイルではない） | operator-agent（＋ watch キャッシュ） | A・B と **live probe** から合成した posture / coherence |

operator-agent は **C を返す**。A の生フィールドを「セッションの状態」と言い換えて断定しない。

### 3. Harness 正本: `harnessPhase` と `modifiedAt`

SessionResumeStore に、harness **のみ**が更新する組を置く。**phase が変わる flush では必ず両方をセット**する。

```
harnessPhase: running | idle | close | abort | exit
modifiedAt:   Unix ms（同一書き込み）
```

| `harnessPhase` | 意味 |
|----------------|------|
| `running` | instance 稼働中。conductor またはいずれか worker に in-flight 処理がある |
| `idle` | instance 稼働中。**conductor と全 worker が idle**（GitHub / CI 等の自律再開の待ちを含む） |
| `close` | `/close` による teardown 完了（再開候補） |
| `abort` | SIGINT / SIGTERM 等による割り込み終了（resume 候補） |
| `exit` | `/exit` による teardown 完了（作業終了・掃除候補。メタデータは retention） |

- プロセス **稼働中**のみ `running` / `idle` を更新する。
- `close` | `abort` | `exit` は **terminal**。[ADR 0035](0035-open-question-shutdown-commit-order.md) と同様、後続 flush で上書きしない。
- `modifiedAt` は harness activity の鮮度の正本とする（phase 遷移、および定義した harness activity で更新するかは実装時に [#561](https://github.com/otolab/agents-ensemble/issues/561) で固定する）。`session-state.reportedAt` は operator 発話の鮮度であり、混同しない。
- 既存 `lifecycle`（`closed` / `exited` / `interrupted` / `unknown`）は移行期間 **マッピング**する: `closed→close`, `exited→exit`, `interrupted→abort`, `unknown` は legacy / 非分類。新規実装では `harnessPhase` を正とする。
- sidecar の `updatedAt` は `--continue` のソート等と整合するよう **`modifiedAt` と同一規則**に寄せる（実装で一本化）。

`resume` 開始時に terminal phase を消すための `unknown` リセットは、`harnessPhase` 導入後は **起動直後の `running`/`idle` と新 `modifiedAt`** に置き換える。

### 4. Operator 到達性（第二層・観測）

**永続化しない正本**として、operator-agent が都度（または watch プールの TTL キャッシュで）判定する。

```
live.connectivity: reachable | unreachable | unknown
live.checkedAt:      Unix ms | null
live.probe:          使用した手段（例: uds_observe）— 任意
live.detail:         エラー要約 — 任意
```

- `harnessSocketPath` は **接続候補の索引**のみ。`reachable` の定義は live control / observe の **成功**に合わせる（[ADR 0037](0037-operator-agent-session-watch-and-dispatch.md)）。
- **SessionResumeStore に `connectivity` を正本として書かない**（キャッシュする場合も観測の副産物とし、鮮度を付ける）。

### 5. Operator 投影 API（合成）

`list_operator_sessions` および詳細取得は、少なくとも次の形で返す（フィールド名は実装で調整可）。

```typescript
persisted: {
  harnessPhase: HarnessPhase | null;
  modifiedAt: number | null;
  source: 'resume_store' | 'legacy_lifecycle';
}
live: {
  connectivity: 'reachable' | 'unreachable' | 'unknown';
  checkedAt: number | null;
}
posture: 'watch' | 'interact' | 'resume' | 'purge' | 'indeterminate';
coherence: 'ok' | 'conflict' | 'insufficient_data';
coherenceReasons?: string[];  // 機械可読コード
```

**`posture`（案）**

| 条件（簡略） | posture |
|--------------|---------|
| 稼働中 + `idle`/`running` + `reachable` | `watch` または `interact`（statusLine で文脈） |
| `close` / `abort` + 典型的に unreachable | `resume` |
| `exit` + unreachable | `purge`（掃除候補。自動削除はしない） |
| 矛盾（例: `exit` + `reachable`、`running` + 長時間 unreachable） | `indeterminate` + `coherence: conflict` |

**`coherence`**

- `ok`: persisted と live がルール上整合。
- `conflict`: 両方観測があるが矛盾（`terminal_but_live_control` 等の reason）。
- `insufficient_data`: legacy のみ、一覧で未 probe、`harnessPhase` 欠落など。

live control 系ツールは **conflict 時に snapshot へ黙って fallback せず**、エラーまたは `indeterminate` を返す（既存契約を維持）。

**一覧と詳細**

- **一覧**: 既定は `live.connectivity: unknown`（軽量）。watch キャッシュがあれば載せる。
- **詳細 / watch**: probe し `coherence` を計算する。

### 6. CLI resume（現行との差）

本 ADR は **product 意図**を固定する。実装は [#561](https://github.com/otolab/agents-ensemble/issues/561) で行う。

- `--continue` は同一 Issue で **`close` / `abort` を resume 候補**、`exit` は優先しない（またはスキップ）方向とする。
- `exit` 付きでも sidecar が残るのは **掃除用メタデータ**であり、resume 推奨ではない。

## Consequences

### 良い点

- harness が管理する値が **`harnessPhase` + `modifiedAt`** に集約され、operator は鮮度と statusLine で「CI 待ちを見守る」判断ができる。
- 永続化（A）と到達性（C の live）が分離され、`exit` ∧ `reachable` を **conflict** として明示できる。
- [ADR 0030](0030-tty-close-lifecycle.md) の `/close` / `/exit` 意図が operator 投影と接続する。

### トレードオフ

- `running` / `idle` は **プロセス内更新**が要り、クラッシュ時は最後の phase が残る（terminal でない限り）。activity と `modifiedAt` の定義をテストで固定する必要がある。
- 投影 API は `list_operator_sessions` の breaking 拡張になりうる（changeset / 移行）。
- [ADR 0011](0011-session-sidecar-resume.md) の用語 sidecar は文書上レガシーとして残る（本文は不変）。

### フォローアップ

- [#560](https://github.com/otolab/agents-ensemble/issues/560): `SessionResumeStore` rename。
- [#561](https://github.com/otolab/agents-ensemble/issues/561): `harnessPhase` 書き込み、`--continue` 規則、operator 投影フィールド実装。
- [architecture.md](../architecture.md) / [session-logging.md](../session-logging.md) / [operator-input.md](../operator-input.md) を本 ADR に合わせて更新（実装 PR と同梱）。
