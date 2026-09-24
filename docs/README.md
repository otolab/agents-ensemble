# ドキュメント

> **正本:** agents-ensemble の文書索引と、各テーマの正本マップ。

文書の種類・更新ルールは [documentation-policy.md](documentation-policy.md) を参照する。

## 正本マップ

同じテーマを複数の文書で説明する場合も、次の文書を正本とする。

| テーマ | 正本 | 補足 |
|--------|------|------|
| CLI の入口・最小クイックスタート | [cli/README.md](cli/README.md) | npm の `@agents-ensemble/cli` README の生成元 |
| 設定全体・環境変数・解決順 | [settings.md](settings.md) | CLI / env / config / profile / TUI の対応表 |
| `config.yaml` の書き方・MCP | [config.md](config.md) | `.ensemble/config.yaml` と `mcp.json` のスキーマ |
| TUI とオペレータ入力の利用者向け挙動 | [operator-input.md](operator-input.md) | キー実装の調査・方針は [cli-text-input-keybindings.md](cli-text-input-keybindings.md) |
| TUI scrollback の検出設計・端末制約 | [tui-scrollback-detection.md](tui-scrollback-detection.md) | native viewport 検出、tmux adapter、A+B の設計境界 |
| 認証トークンの解決 | [settings.md](settings.md) | `config.yaml` の認証関連キーは [config.md](config.md) |
| conductor send の再接続設計 | [conductor-auth-reconnect.md](conductor-auth-reconnect.md) | 認証設定そのものの正本ではない |
| 現行の技術構成 | [architecture.md](architecture.md) | 判断の履歴は ADR |
| テスト分類・実行方針 | [testing-strategy.md](testing-strategy.md) | unittest / integration / e2e |
| 開発環境・テスト実行 | [development.md](development.md) | worktree・pnpm・ブランチ運用の注意 |
| 文書の更新ルール | [documentation-policy.md](documentation-policy.md) | ADR 不変性・索引の役割 |

## 利用者向け（CLI）

| 文書 | 内容 |
|------|------|
| [cli/README.md](cli/README.md) | インストール・認証準備・最小クイックスタート・利用者向け doc 索引 |
| [settings.md](settings.md) | CLI / 環境変数 / config / profile / TUI の設定一覧と解決順（設定全体の正本） |
| [config.md](config.md) | `.ensemble/config.yaml` の配置・書き方・スキーマ・MCP 設定（config の正本） |
| [operator-input.md](operator-input.md) | TUI のレイアウト、オペレータ入力、post-loop の利用者向け契約 |
| [tui-scrollback-detection.md](tui-scrollback-detection.md) | scrollback 閲覧検出の設計・端末別 C 可否・副作用 |
| [cli-text-input-keybindings.md](cli-text-input-keybindings.md) | TUI 入力ショートカットの実装階層・対応状況（参照） |
| [user-teams.md](user-teams.md) | `~/.ensemble/teams/` の user team profile の配置・解決順 |
| [conductor-auth-reconnect.md](conductor-auth-reconnect.md) | conductor send の認証エラー時の in-process 再接続（設計正本） |

## 運用・可観測性

| 文書 | 内容 |
|------|------|
| [session-logging.md](session-logging.md) | stdout / stderr / TUI / 終了 JSON の出力チャネルと SessionLogger |
| [session-metrics.md](session-metrics.md) | 終了サマリ、usage、worker 状態などのメトリクス |

## 設計・アーキテクチャ

| 文書 | 内容 |
|------|------|
| [architecture.md](architecture.md) | SDK conductor + ACP worker の現行技術アーキテクチャ |
| [elements.md](elements.md) | skill、worker、profile、Issue、PR などの構成要素 |
| [orchestrator.md](orchestrator.md) | conductor / orchestrator の責務の整理 |
| [harness-events.md](harness-events.md) | harness の SessionLogEvent / SessionEvent と出力語彙 |
| [adr/](adr/README.md) | 設計判断の履歴（ADR）と不変性ルール |

## 開発者向け

| 文書 | 内容 |
|------|------|
| [development.md](development.md) | ローカル開発・テスト・worktree・ブランチ運用の注意 |
| [testing-strategy.md](testing-strategy.md) | unittest / integration / e2e の分類と実行方針 |
| [modular-prompt.md](modular-prompt.md) | modular-prompt のセクション分担と実装との一致 |
| [../AGENTS.md](../AGENTS.md) | エージェント向け索引 |

## 作業手順（prompts）

システム仕様の正本ではない。手順の索引は [prompts/README.md](prompts/README.md)。

| 文書 | 内容 |
|------|------|
| [prompts/pr-review.md](prompts/pr-review.md) | PR レビューの観点・完結性 |
| [prompts/issue-workflow.md](prompts/issue-workflow.md) | Issue 作業フローの参考フレーム |
| [prompts/worker-bootstrap.md](prompts/worker-bootstrap.md) | worker 起動プロンプトのパターン例 |
| [prompts/release.md](prompts/release.md) | changeset・Release PR・npm 公開 |

## 参考

| 文書 | 内容 |
|------|------|
| [design.md](design.md) | 設計の大原則と固くしないもの（参照） |
