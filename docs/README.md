# ドキュメント

agents-ensemble（`ensemble` コマンド）の設計・検討事項。

| 文書 | 内容 |
|------|------|
| [architecture.md](architecture.md) | **技術アーキテクチャ**（SDK conductor + ACP worker） |
| [session-logging.md](session-logging.md) | **セッションロギング**（stdout/stderr 分離・SessionLogger・終了 JSON） |
| [design.md](design.md) | 大原則・全体像 |
| [elements.md](elements.md) | 構成要素（skill, worker, issue 等） |
| [orchestrator.md](orchestrator.md) | オーケストレータの役割 |
| [pipeline.md](pipeline.md) | 作業フロー（参考） |
| [prompts.md](prompts.md) | 起動プロンプトのパターン |
| [modular-prompt.md](modular-prompt.md) | **modular-prompt の書き方**（セクション分担・アンチパターン） |
| [implementation.md](implementation.md) | 実装方針の検討 |
| [testing-strategy.md](testing-strategy.md) | **テスト戦略**（unittest / integration / e2e） |
| [adr/](adr/README.md) | **ADR**（設計判断の履歴） |
| [../AGENTS.md](../AGENTS.md) | **エージェント向け指針**（レビュー方針含む） |

関連 Issue: [otolab/my-logs#2027](https://github.com/otolab/my-logs/issues/2027)
