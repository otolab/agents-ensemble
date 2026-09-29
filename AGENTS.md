# AGENTS.md

このリポジトリで作業・レビューするエージェント（および人間）向けの索引。

文書の種類と更新ルールは [docs/documentation-policy.md](docs/documentation-policy.md) を正本とする。

## システムの正本

| 文書 | 内容 |
|------|------|
| [docs/architecture.md](docs/architecture.md) | 現行の技術構成 |
| [docs/session-logging.md](docs/session-logging.md) | セッションのログ・表示 |
| [docs/adr/](docs/adr/README.md) | 設計判断の履歴（ADR。本文は不変） |
| [docs/README.md](docs/README.md) | 各テーマの正本マップ |

## 作業手順

| 文書 | 内容 |
|------|------|
| [docs/prompts/pr-review.md](docs/prompts/pr-review.md) | PR レビューの観点・完結性・チェックリスト |
| [docs/prompts/issue-workflow.md](docs/prompts/issue-workflow.md) | Issue 作業フローの参考フレーム |
| [docs/prompts/worker-bootstrap.md](docs/prompts/worker-bootstrap.md) | worker 起動プロンプトのパターン例 |
| [docs/prompts/release.md](docs/prompts/release.md) | changeset・Release PR・npm 公開 |
| [docs/development.md](docs/development.md) | 開発環境・テスト・ブランチ運用の注意 |

作業の記録・受け入れ条件は **GitHub Issue** を正本とする。

## PR 完結性と認証統合

PR は受け入れ条件だけでなく、変更が及ぶ利用者向け文書・運用導線まで完結させる。今回の Pi backend の認証統合はスコープ外だが、`ensemble auth` と Pi provider 認証を統合する作業は既存の [Issue #356](https://github.com/otolab/agents-ensemble/issues/356) に明示的に引き継ぐ。レビュー時の判断基準は [PR レビュー手順](docs/prompts/pr-review.md) を参照する。
