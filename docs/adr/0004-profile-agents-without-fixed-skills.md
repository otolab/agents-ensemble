# ADR 0004: プロファイル — agent 定義と Skill 非固定

- Status: accepted
- Date: 2026-08-08

## Context

worker はフルセットの Cursor CLI 上で動き、**環境の Skill にアクセスできる**。一方、テストや Skill を前提にできない環境では、Skill 名を profile に固定すると存在しない Skill を指す危険がある（例: `skill: implementer`）。

プロファイルで決めるべきは:

- 誰を起動するか（worker 名・kind）
- conductor 向け materials（役割分担・いつ Skill を読むかの**自然言語**）
- kind ごとの system prompt（agent 定義）

## Decision

プロファイル YAML の形:

```yaml
agents:
  ping:
    systemPrompt: |
      応答に pong とだけ含めて終了してください。

workers:
  - name: ping-1    # セッション内の識別名（一意）
    kind: ping      # agents.<kind> を参照
  - ping            # 省略: name=kind=ping

materials:
  - id: team
    file: team.md
```

- **`skill` フィールドは profile に置かない**。必要なら materials で「〜 Skill に基づいて作業せよ」と書く。worker が読み込む
- **`kind`**: agent 定義（system prompt）の選択子。将来 modular-prompt 構造の YAML 化（Phase B）
- **`name`**: セッション内の worker 識別。ログ・materials・conductor サマリで参照
- 同梱プロファイルの正本: リポジトリ直下 `profiles/`。`build` で `packages/core/dist/profiles/` にコピー

コード側フォールバック: `agents.<kind>` 未指定時は `agents.default` → 組み込み `defaultAgentModule`（Skill 名の埋め込みなし）。

## Consequences

- 良い: 本番（Skill あり）とテスト（Skill なし ping/pong）を同じ枠組みで扱える
- 悪い: Skill の所在は実行環境依存。materials だけでは読み忘れうる
- フォロー:
  - Phase B: `agents.<kind>` を modular-prompt 構造で記述
  - integration: `dispatchWorker` / `WorkerSession` + Fake ACP（[testing-strategy.md](../testing-strategy.md)）
