# ADR 0020: ensemble config.yaml の設定解決順

- Status: accepted
- Date: 2026-08-21

## Context

[#223](https://github.com/otolab/agents-ensemble/issues/223) で `.ensemble/config.yaml` の 2 層 merge（user → project）と GitHub 認証フォールバック 1 項目を導入した。[#228](https://github.com/otolab/agents-ensemble/issues/228) では team profile 既定・conductor model・ACP preset・session 既定・GitHub monitor 等が **env / CLI / コード定数に分散**しており、利用者向け正本（README / `docs/config.md`）も項目ごとに優先順の記述が揃っていなかった。

要件:

- config を **横断設定の正本**として拡張しつつ、既存 env 利用者（config 未作成）の挙動を維持する
- CLI は invocation 単位の上書き、env は CI 注入用として残す
- 解決順を **全 Phase 1 項目で同一**にし、テストで固定する

## Decision

### 解決順（Phase 1 全項目共通）

```
CLI 明示指定 > 環境変数 > project .ensemble/config.yaml > user ~/.ensemble/config.yaml > コード内デフォルト
```

- `loadEnsembleConfig(repoRoot)` が user → project を deep merge した `EnsembleConfig` を返す
- 各設定項目は `packages/core/src/config/resolve-settings.ts` の `resolve*Setting` で上記順に解決する
- 未知 config キーは無視、型不一致は **該当キーのみ**フォールバック（#223 方針維持）

### Phase 1 スコープ

config に載せる: `profile.default`, `conductor.model`, `acp.defaultPreset`, `session.*`, `github.monitor.*`（`github.auth` は #223 から継続）。

載せない: token 平文、resume 系 CLI 専用項目、`acp.defaultCommand` / `defaultArgs`（Phase 2）。

### 実装配置

- スキーマ: `packages/core/src/config/types.ts`, `parse-config.ts`, `defaults.ts`
- 解決: `resolve-settings.ts`
- 起動経路: `ensemble issue`（`issue-command.ts` → `runConductorSession`）が config を読み、CLI / env と merge して session に渡す

## Consequences

### 良い点

- チーム / 個人の既定を config に集約でき、README の env 表と矛盾しない単一ルールになる
- 後方互換テストで env-only 利用を担保できる
- 将来のキー追加は `resolve-settings` + `parse-config` + docs の同型パターンに乗せられる

### トレードオフ

- commander の固定 default（例: `--worktree isolated`）は config 既定と二重化しうるため、config 連動項目は CLI 側 default を外し `issue-command` で解決する
- profile `acp` / worker `acp` がある worker は従来どおり CLI / config preset より profile 側が優先（worker spawn の局所ルールは維持）

### フォローアップ

- Phase 2: `acp.defaultCommand` / `defaultArgs`, `ensemble config validate/show`, env deprecated 警告（[#228](https://github.com/otolab/agents-ensemble/issues/228) 非スコープ）
