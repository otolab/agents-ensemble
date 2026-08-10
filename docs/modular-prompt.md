# modular-prompt の書き方（agents-ensemble）

`@modular-prompt/core` で system prompt を組み立てるときの指針。実装は `packages/core/src/prompt/modules/`。

**常にマージ後の1枚**（`renderCompiledPrompt(compile(...))` の出力）を頭に置いて書く。モジュール分割は実装の都合であり、エージェントが読むのは結合後のドキュメントである。

## モジュール構成

| モジュール | 読者 | merge |
|------------|------|-------|
| `baseModule` | conductor + worker 全員 | 常に先頭 |
| `conductorBaseModule` | conductor のみ | `base` の後 |
| `workerBaseModule` | worker のみ | `base` の後 |
| profile 起動文書（`*.md`） | 役割ごと | 最後に追記（`instructions`） |
| profile materials（`team.md` 等） | 全員共通 | 最後に追記（`materials` → Prepared Materials） |

compile 時の context は `EnsembleContext`（`kind`, `issueUrl`, `issueNumber`, `workers`, `kinds`）。`ensembleContext(kind, issueUrl, sessionState)` で組み立てる。`sessionState` は `sessionStateFromProfile(profile)` で profile から取る。base の **objective** は Issue 解決目標、**state** は workers 構成と kind 一覧。

profile 起動文書は **instructions 相当の追記**として載る。profile materials は **Prepared Materials** に載せ、materials があるときは instructions に「行動時の定義として読む」旨を1行追記する。ensemble 側に書くべき共通前提を profile に重複させない。

## セクションの分担

modular-prompt の標準セクションのうち、ensemble で主に使うもの:

| セクション | 書くこと | 書かないこと |
|------------|----------|--------------|
| **persona** | 自分は誰か（`kind` など） | 手順・ツール |
| **objective** | この役割は何のためにいるか | 用語定義・実装詳細 |
| **terms** | **この文脈で意味がずれる語**の定義のみ | 一般語の言い換え、運用ルール、手順 |
| **methodology** | **operator – conductor – workers** の関係構造と、**中立な役割分担**（誰が何を担うかの簡潔な説明） | 特定ロールへの命令、手順の細部、ツールの使い方 |
| **instructions** | **そのロールの**振る舞い、禁止事項、連携の手順、**ツールの使い方** | 用語の定義、harness の実装、全員向けの中立な分担説明 |
| **state** | セッションの実行時データ（profile の **workers** 構成、**agents** の kind 一覧） | 用語定義、振る舞いの指示 |

`guidelines` は原則使わず、指示的な内容は `instructions` へ寄せる（[base-module コメント](../packages/core/src/prompt/modules/ensemble/base-module.ts) と同じ方針）。

### terms に載せる語の目安

載せる:

- システム固有の概念（**permission**, **open question**, **worktree**, **kind**）
- 一般語と意味がずれるもの（**permission** = この harness の許可フロー、など）

載せない:

- **判断**, **作業** など、文脈なしでも通じる一般語
- harness の実装語（**bootstrap**, ACP, sidecar など）
- 中立な役割分担の説明（→ `methodology`）
- 特定ロールへの命令・手順（→ `instructions`）

### methodology に載せるもの

全員が同じ前提で読む、**薄い方法論**。2層ある。

1. **関係構造** — 誰が誰の上にいるか、誰と誰がつながるか
2. **役割分担** — 誰が何を担うかの簡潔な説明（**中立文**。「あなたは〜」ではない）

載せる例:

- オペレータが conductor を監督する
- conductor が worker 群を調整する
- worker はセッション開始時からすでにいる。worker 同士は直接つながらない
- 作業の実行は worker、方針・許否・調整は conductor
- 判断に困ることは conductor が扱う。conductor が決められないことはオペレータが最終判断する

載せない例（→ `instructions`）:

- 判定に迷うものは conductor に返す（worker への命令）
- 自分で決められないときは `ask_human` する（conductor への命令）
- Issue / PR に書く、permission を要求する（手順・振る舞い）
- `prompt_worker` の使い方（ツール）

**見分け:** methodology は三人称・システムの話。instructions は読者への指示。

### instructions に載せるもの

- **そのロールの**具体的振る舞い（「〜しろ」「〜するな」「〜に返す」）
- 禁止事項（conductor: 演奏しない、など）
- 連携の手順（いつ・何を・どう送るか）
- ツール名ごとの使い方（`### prompt_worker`, `### open question`）

## subsection のルール

compile 後は `### {title}` になる。**タイトルがマージ後の見出しとして情報を足すときだけ**使う。

| 良い例 | 理由 |
|--------|------|
| `### prompt_worker` | ツール名。複数行の使い方をまとめる |
| `### open question` | 関連ツール群のまとまり |
| `### 参加者`（terms 内） | 用語集のカテゴリとして意味がある |

| 悪い例 | 理由 |
|--------|------|
| `### 全員` | すでに `## Instructions` を読んでいる |
| `### harness` / `### 運用` / `### 連携` | 実質ラベルだけで、見出しとして機能しない |
| `### permission`（1行だけ） | フラットな1行で足りる |

1行だけの禁止事項も subsection にしない（フラットな `- ...` でよい）。

## 読者を意識する（アンチパターン集）

### 1. 共通モジュールに役割向けの命令

```text
# 悪い（base に置くと conductor が「自分に返せ」と読む）
- 判定に迷うものは conductor に返す
```

→ worker 向けなら `workerBaseModule.instructions`。全員向けの**中立な**分担説明なら `methodology`。

### 2. 運用ルールを terms に入れる

```text
# 悪い（「判断」の定義ではない）
- **判断**: 困ったら conductor が…。無理ならオペレータが…
```

→ 語の定義ではない。**中立な分担**なら `methodology`、**読者への指示**なら `instructions`。`判断` という語自体の定義は不要なら terms に書かない。

### 3. 中立な分担説明を instructions に入れる

```text
# 悪い（base.instructions に置くと全員への命令のように読める）
- 判断に困ることは conductor が扱い、…オペレータが最終判断する
```

→ 内容は正しくても置き場所が違う。三人称の分担説明は `methodology`。`instructions` に置くのは「あなた（このロール）は〜」の振る舞い。

### 4. 特定ロールへの命令を methodology に入れる

```text
# 悪い（worker への指示が方法論の体裁）
- 判定に迷うものは conductor に返す
```

→ methodology は全員向けの中立文。ロール固有の命令は `instructions`。

### 5. 指摘された文を近いスロットに入れるだけ

「定義を書いて」≠ 必ず `terms`。**語の意味**か**中立な分担**か**ロールへの指示**かを先に分類する。

### 6. harness の用語をエージェントに渡す

```text
# 悪い
- **bootstrap**: ACP セッションとして…
```

エージェントに必要なのは体験（「すでに起動している」「作業指示を待つ」）。起動方式はコード側。

### 7. 同じ概念を複数モジュールで言い換え定義

`作業指示` の送受は **methodology**（中立な仕組みの説明）と各ロールの **instructions**（届いたらどうする／どう送る）に分ける。terms に載せない。

### 8. 実装前の仕様を確定事項のように書く

未実装の経路（例: `prompt_worker`）は **できる体**で書き、ソースに `FIXME(#36)` を付ける。プロンプト本文に FIXME は載せない。

## 実装との一致

- プロンプトに書くことは **いま動く経路**か、FIXME 付きの **目標仕様**のどちらか
- 「Issue / PR に書けば worker が動く」は誤り（正本 ≠ トリガー）— [#36](https://github.com/otolab/agents-ensemble/issues/36)
- profile 起動文書（`profiles/default/*.md`）も merge される。ensemble と矛盾させない

## 確認手順

1. `renderCompiledPrompt(compile(merge(...), ctx))` の全文を読む
2. 各 `###` 見出しを「なくても読めるか」で検査する
3. conductor 用・worker 用の両方で、**自分への矛盾した命令**がないか見る
4. `ensemble-modules.test.ts` などで最低限のフレーズを固定する

## 関連

- [architecture.md](architecture.md) — modular-prompt と SDK / ACP の分担
- [ADR 0009](adr/0009-conductor-session-event-queue.md) — conductor の inbound イベント
- Issue [#36](https://github.com/otolab/agents-ensemble/issues/36) — conductor → worker 指示経路
- Issue [#34](https://github.com/otolab/agents-ensemble/issues/34) — worker-and-reviewer プロファイル
