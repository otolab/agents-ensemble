# テスト戦略

> **正本:** agents-ensemble のテスト分類・配置・実行条件と、CI が常時実行する範囲。

テストレベルはファイル名と配置で明示する。Vitest の include/exclude、package scripts、CI コマンドもこの分類に合わせる。レベルごとの目的を分け、同じ振る舞いの重複は、低レベルの詳細検証と上位レベルの少数の契約 smoke のように、境界を確認する理由がある場合に限る。

## テストレベルと命名

| レベル | 命名・配置 | 主な境界 |
|--------|------------|----------|
| **unit** | `packages/*/src/**/*.test.ts[x]` | モジュールや package 内の状態・変換。Fake / mock を使い、実 ACP・Cursor SDK・GitHub API には接続しない |
| **integration** | `packages/core/test/integration/**/*.integration.test.ts` | core API、複数モジュール、Fake ACP、または設定された実 ACP / Cursor SDK の接続 |
| **e2e** | `packages/cli/test/e2e/**/*.e2e.test.ts` | `ensemble` CLI を入口にしたユーザー操作とプロセス終了までの確認 |
| **補助 Node test** | `.github/scripts/*.test.mjs`、`scripts/pi/*.test.mjs` | Vitest workspace 外の Node.js スクリプトの検証。実行コマンドとCI範囲は個別に記録する |

`*.integration.test.ts` と `*.e2e.test.ts` は `src/` に置かない。unit 設定は両 suffix を明示的に除外し、integration / e2e 設定はそれぞれのディレクトリと suffix の組だけを含める。

少数の unit test は、process 管理関数を確かめるために `process.execPath` で短命な Node fixture を起動する。また CLI の version / TTY 前提チェックはビルド済み CLI を子プロセスで呼ぶ。対象が単一の process helper または CLI gate で、実ACP・外部サービス・Issue workflow を通さないため unit suite に含める。実ACPを起動するもの、PTY 上で実 CLI のセッションを動かすものは integration / e2e に置く。

`packages/cli/src/issue-command-session.test.ts` と `packages/core/src/conductor/conductor-session.test.ts` は複数モジュールを接続するが、Fake ACP / conductor / TUI を注入して package 内の session orchestration を直接検証するため unit suite に含める。前者は一時 Git repository と Git worktree、後者はローカル UDS を使う。実 executable・ACP backend・外部 service まで通すテストとの境界は e2e / integration に置き、これらは「in-process orchestration smoke」としての明示的な例外とする。

## Workspace と実行コマンド

| workspace / 領域 | 種別 | 実行コマンド | PR / main CI 常時実行 | 追加条件 |
|------------------|------|--------------|----------------------|----------|
| `@agents-ensemble/core` | unit | `pnpm --filter @agents-ensemble/core test:run` | はい。root の `pnpm test:run` に含まれる | Node.js 22、Git、一時ディレクトリ、ローカル UDS。子プロセスは制御された Node fixture のみ |
| `@agents-ensemble/core` | integration | `pnpm --filter @agents-ensemble/core test:integration` | 一部のみ。下記「CI 常時実行範囲」を参照 | Fake / in-process suite は追加設定不要。実 `agent acp` suite は `test-acp.yaml` と利用可能な `agent` が必要。Cursor SDK suite は認証、ネットワーク、書き込み可能な隔離 HOME が必要 |
| `@agents-ensemble/core` | e2e | なし | なし | 現在 core に e2e suite はない。Vitest e2e config と package script は設けない |
| `@agents-ensemble/cli` | unit | `pnpm --filter @agents-ensemble/cli test:run` | はい。root の `pnpm test:run` に含まれる | Node.js 22、Git、一時ディレクトリ、ローカル UDS。ビルド済み CLI を起動するテストがあるため、単独実行前に `pnpm build` が必要 |
| `@agents-ensemble/cli` | e2e | `pnpm --filter @agents-ensemble/cli test:e2e` | 一部のみ。PTY suites を個別に実行 | 先に `pnpm build` が必要。PTY suites は POSIX と Python 3 の標準 `pty` モジュールが必要。Pi TTY suites は localhost bind と Git も使う。Issue workflow suite は `test-acp.yaml`、Issue URL、repo、conductor 認証、利用可能な ACP 実行環境が必要 |
| `@agents-ensemble/operator-agent` | unit | `pnpm --filter @agents-ensemble/operator-agent test:run` | はい。root の `pnpm test:run` に含まれる | Node.js 22、一時ディレクトリ、ローカル UDS。外部 agent / service は不要 |
| `.github/scripts` | Node test | `pnpm test:release-workflow` | はい | Node.js 22 と Git。テスト用の一時 Git repository を使い、GitHub には接続しない |
| `scripts/pi` | Node test | `node --test scripts/pi/cached-auth.test.mjs` | いいえ | Node.js。Linux 固有の PID namespace / procfs を検証する2ケースは非Linuxで skip。CI 対応は Issue #475 の範囲 |

Root scripts:

```bash
pnpm test              # core の Vitest watch
pnpm test:run          # 各 workspace の test:run を一括実行（CI の unit suite）
pnpm test:release-workflow
pnpm test:integration  # core integration 全体。設定済み実依存 suite を含む
pnpm test:e2e          # CLI e2e 全体。Issue workflow suite は設定・認証時のみ実行
pnpm test:all          # test:run → test:integration → test:e2e
```

`pnpm test:all` にはビルドが含まれない。CLI の dist を使う unit / e2e も通す場合は、先に `pnpm build` を実行する。

## Vitest 設定

| 設定 | include | exclude / 補足 |
|------|---------|----------------|
| `packages/core/vitest.config.ts` | `src/**/*.test.ts` | `*.integration.test.ts`、`*.e2e.test.ts` と `test/integration/**`、`test/e2e/**` を除外 |
| `packages/core/vitest.config.integration.ts` | `test/integration/**/*.integration.test.ts` | e2e suffix を除外。直列実行、60 秒 timeout |
| `packages/cli/vitest.config.ts` | `src/**/*.test.ts`、`src/**/*.test.tsx` | integration / e2e suffix と `test/e2e/**` を除外 |
| `packages/cli/vitest.config.e2e.ts` | `test/e2e/**/*.e2e.test.ts` | 直列実行、最大5分 timeout |
| `packages/operator-agent/vitest.config.ts` | `src/**/*.test.ts` | integration / e2e suffix を除外 |

integration / e2e は副作用のあるプロセスや共有状態を避けるため直列実行する。unit suite 内の子プロセス fixture は各テストが自分で起動・終了し、ネットワークサービスや認証状態を共有しない。

## 外部環境を使うテスト

| 対象 | 分類 | 前提と実行範囲 |
|------|------|----------------|
| `packages/core/src/acp/acp-client.test.ts`、`process-stream-capture.test.ts` | unit の process-helper fixture | Node.js 子プロセスをテスト自身が起動する。agent / ACP / network は不要。unit suite としてPR / main CIで実行 |
| `packages/cli/src/cli-version.test.ts`、`operator-agent-command.test.ts` | unit の CLI gate smoke | ビルド済み `packages/cli/dist/index.js` を起動する。CI は先に `pnpm build` を実行。GitHub / ACP 接続は不要 |
| core / cli / operator-agent の session orchestration tests | unit の in-process orchestration smoke | Fake ACP / conductor / TUI と一時 repository、ローカル UDS を使う。Git と UDS が使えるCI環境で常時実行し、実 ACP / 外部 service には接続しない |
| core `test/integration` の Fake / in-process suites | integration | 一時ファイル、Fake ACP、または Node の ACP fixture を利用する。外部認証なしでローカル実行可能。CI では指定 suite のみ常時実行 |
| `acp-bridge.integration.test.ts` | integration | `test-acp.yaml` と、そこに指定する利用可能な `agent` / ACP backend が必要。設定ファイルがなければ suite を skip。設定済みで実行不能な場合は失敗として扱う |
| `conductor-agent.integration.test.ts`、`issue-session.integration.test.ts` | integration | 実 Cursor SDK、認証（`CURSOR_API_KEY` または SDK login）、ネットワーク、隔離 HOME 用の一時書き込み領域が必要。認証がない、または隔離 HOME を準備できない場合は suite を skip |
| `packages/cli/test/e2e/issue.e2e.test.ts` | e2e | `packages/core/test/integration/test-acp.yaml` に有効な `issueUrl` と `repoRoot` があり、conductor 認証と GitHub API 認証（`GITHUB_TOKEN` / `GH_TOKEN` または設定済み `gh` fallback）が使える場合に実行。agent / ACP backend とネットワークも必要 |
| CLI の TTY process / Pi TTY e2e | e2e | Python 3 の標準 `pty`、POSIX process group、localhost bind、Git が必要。PTY 非対応の Windows では該当テストを skip。PR / main のUbuntu runnerでは実行 |
| `scripts/pi/cached-auth.test.mjs` | 補助 Node test | Linux PID namespace と procfs に関する2ケースだけ非Linuxで skip。スクリプト suite 自体は明示コマンドで実行し、CI では実行しない（Issue #475 の範囲） |

PTY e2e は外部認証や `test-acp.yaml` を必要としない。Pi TTY suites はモデル応答と GitHub API に localhost の fixture server を使い、Git で一時 repository を用意する。`tty-close-process.e2e.test.ts` は fake GitHub / ACP 応答と一時 Git repository を使う。いずれも Python 3 の `pty` と POSIX process group が必要。`issue-pi-tty-exit.e2e.test.ts` は `/exit` 後の自然終了と stdio MCP child 回収、`issue-pi-tty-close.e2e.test.ts` は `/close`・child 回収・保存済み Pi session の `--continue`、`tty-close-process.e2e.test.ts` は CLI session teardown・worker child 終了・worktree 保持を確認する。

## 明示的な skip の記録

環境条件による `skip` / `skipIf` は、テストまたはこの表に次の3点を残す。

1. **必要条件** — 環境変数、設定ファイル、認証、OS / 実行環境
2. **理由** — 条件が欠けたときに実行できない外部境界
3. **解除方法** — 条件を満たして再実行する手順。恒常的に解消できない依存なら追跡 Issue

| skip / guard | 必要条件・理由 | 解除方法 / 追跡 |
|--------------|----------------|------------------|
| Cursor SDK integration の `describe.skipIf` | Cursor 認証、ネットワーク、書き込み可能な隔離 HOME がないと実接続できない。`ENSEMBLE_CURSOR_SDK_INTEGRATION_SKIP` は理由付きで明示的に skip する override | 認証を設定し一時 HOME を作成できる環境で実行し、override を設定している場合は unset。カスタム HOME を使う場合は `ENSEMBLE_INTEGRATION_HOME` に認証済みの隔離 HOME を指定 |
| `acp-bridge.integration.test.ts` の `describe.skipIf` | `test-acp.yaml` がない場合、選択された実 ACP backend を起動できない | example からローカル設定を作り `agent` と backend を用意して該当 suite を実行 |
| `issue.e2e.test.ts` の `describe.skipIf` | Issue / repository 設定または conductor 認証がない場合、Issue workflow を実行できない | `test-acp.yaml` と認証を設定して `pnpm test:e2e` を実行 |
| `cli-version.test.ts` の `describe.skipIf` | package 単独の unit 実行時に build artifact がない場合、dist CLI を起動できない | `pnpm build` 後に再実行。CI は build 済みのためこの skip に入らない |
| CLI TTY e2e の Windows `skipIf` | Python 標準 `pty` と POSIX process group に依存し、Windows では同じ PTY 条件を提供できない | Python 3 `pty` を備えた POSIX 環境で実行。CI は Ubuntu |
| `scripts/pi/cached-auth.test.mjs` の Linux 条件 skip | PID namespace / procfs の Linux 挙動を直接検証する2ケース | Linux 上で `node --test scripts/pi/cached-auth.test.mjs` を実行。CI 導入・対応は Issue #475 |

棚卸し時点で、前提と再実行方法が上記のように定まった skip は意図的なものだった。不要な skip は見つからなかった。新しい環境 skip を加える場合、理由のない恒久 skip にせず、前提・理由・解除方法と必要なら追跡 Issue を同じ変更で記録する。

## CI 常時実行範囲

`.github/workflows/ci.yml` は pull request と `main` push で次を実行する。

| CI step | 実行対象 |
|---------|----------|
| Build | `pnpm build` |
| Unit tests | `pnpm test:run` — core / cli / operator-agent の全 unit suite |
| Release workflow tests | `pnpm test:release-workflow` — `.github/scripts` の Node test |
| Session resume integration | `test/integration/session-resume.integration.test.ts` |
| Operator usage integration | `test/integration/usage-operator.integration.test.ts` |
| Pi conductor integration | `pi-conductor.integration.test.ts`、`pi-headless-settings.integration.test.ts`、`pi-conductor-agent-registry.integration.test.ts` |
| CLI TTY e2e | `tty-close-process.e2e.test.ts`、`issue-pi-tty-exit.e2e.test.ts`、`issue-pi-tty-close.e2e.test.ts` |

常時実行の integration / e2e は Fake またはローカル fixture を使い、Cursor / GitHub 認証や `test-acp.yaml` を要求しない。PTY suite には Ubuntu runner 上の Python 3 `pty`、POSIX process group、Git が必要であり、Pi TTY suites は localhost bind も使う。Issue workflow 全体、実 ACP、実 Cursor SDK の suite は通常 CI の対象外。`.github/scripts` の Node tests は対象だが、`scripts/pi/cached-auth.test.mjs` は対象外である。

## 参照

- [development.md](development.md) — 開発環境・テスト実行
- [architecture.md §4](architecture.md) — ACP 起動パターン
- [modular-prompt: TESTING_STRATEGY.md](https://github.com/otolab/modular-prompt/blob/main/docs/TESTING_STRATEGY.md)
- [modular-prompt: vitest.config.ts](https://github.com/otolab/modular-prompt/blob/main/packages/driver/vitest.config.ts)
