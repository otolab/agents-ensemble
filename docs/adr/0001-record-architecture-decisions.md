# ADR 0001: ADR を残す

- Status: accepted
- Date: 2026-08-08

## Context

設計判断（例: conductor の plan mode、プロファイルの形）が architecture 本文や会話に散らばり、「なぜそうしたか」「検証したか」が後から追えない。  
architecture.md は**現状の正本**として長く保ちたいが、判断の経緯とトレードオフは別に残したい。

## Decision

`docs/adr/` に Architecture Decision Record を置く。

- 1 判断 = 1 ファイル（`NNNN-kebab-title.md`）
- 一覧は [README.md](README.md)
- 日本語で書く（このリポジトリの他ドキュメントと同じ）

## Consequences

- 良い: 議論の再開が速い。未検証の仮説と確定事項を分けやすい
- 悪い: 正本との二重管理。ADR を更新し忘れると古くなる
- フォロー: 大きな設計変更時は ADR 追加を検討。architecture 変更とセットで PR に載せる
