# ドキュメント

> **正本:** agents-ensemble の文書を読者別に分類し、各テーマの正本を示すドキュメント索引です。

agents-ensemble（`ensemble` コマンド）の利用・運用・設計・開発に関する索引です。

## 正本マップ

同じテーマを複数の文書で説明する場合も、次の文書を正本とします。

| テーマ | 正本 | 補足 |
|--------|------|------|
| CLI の入口・最小クイックスタート | [cli/README.md](cli/README.md) | npm の `@agents-ensemble/cli` README の生成元 |
| 設定全体・環境変数・解決順 | [settings.md](settings.md) | CLI / env / config / profile / TUI の対応表 |
| `config.yaml` の書き方・MCP | [config.md](config.md) | `.ensemble/config.yaml` と `mcp.json` のスキーマ |
| TUI とオペレータ入力の利用者向け挙動 | [operator-input.md](operator-input.md) | キー実装の調査・方針は [cli-text-input-keybindings.md](cli-text-input-keybindings.md) |
| 認証トークンの解決 | [settings.md](settings.md) | `config.yaml` の認証関連キーは [config.md](config.md) |
| conductor send の再接続設計 | [conductor-auth-reconnect.md](conductor-auth-reconnect.md) | 認証設定そのものの正本ではない |
| 現行の技術構成 | [architecture.md](architecture.md) | 判断の履歴は ADR |

## 利用者向け（CLI）

| 文書 | 内容 |
|------|------|
| [cli/README.md](cli/README.md) | インストール・認証準備・最小クイックスタート・利用者向け doc 索引 |
| [settings.md](settings.md) | CLI / 環境変数 / config / profile / TUI の設定一覧と解決順（設定全体の正本） |
| [config.md](config.md) | `.ensemble/config.yaml` の配置・書き方・スキーマ・MCP 設定（config の正本） |
| [operator-input.md](operator-input.md) | TUI のレイアウト、オペレータ入力、post-loop の利用者向け契約 |
| [cli-text-input-keybindings.md](cli-text-input-keybindings.md) | TUI 入力ショートカットの実装階層・対応状況（参照） |
| [user-teams.md](user-teams.md) | `~/.ensemble/teams/` の user team profile の配置・解決順 |
| [conductor-auth-reconnect.md](conductor-auth-reconnect.md) | conductor send の認証エラー時の in-process 再接続（設計正本） |

## 運用・リリース

| 文書 | 内容 |
|------|------|
| [RELEASE_GUIDE.md](RELEASE_GUIDE.md) | changeset、Release PR、npm 公開の手順（リリースの正本） |
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
| [testing-strategy.md](testing-strategy.md) | unittest / integration / e2e の分類と実行方針 |
| [implementation.md](implementation.md) | 実装方針・段階導入の検討メモ |
| [modular-prompt.md](modular-prompt.md) | modular-prompt のセクション分担と実装との一致 |
| [../AGENTS.md](../AGENTS.md) | エージェント向け作業・レビュー指針 |

## 参考・歴史

| 文書 | 内容 |
|------|------|
| [design.md](design.md) | 設計の大原則と固くしないもの（参照） |
| [pipeline.md](pipeline.md) | Issue 作業フローの参考フレーム |
| [prompts.md](prompts.md) | worker 起動プロンプトのパターン |

関連 Issue: [otolab/my-logs#2027](https://github.com/otolab/my-logs/issues/2027)
