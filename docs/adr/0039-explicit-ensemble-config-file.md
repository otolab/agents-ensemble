# ADR 0039: 起動時に指定する ensemble config ファイル

- Status: accepted
- Date: 2026-10-22

## Context

ADR 0020 は `~/.ensemble/config.yaml` と `<repoRoot>/.ensemble/config.yaml` を user → project の順に merge し、設定項目ごとに CLI / env / config / default を解決する。モデルや ACP env を一時的に切り替えるために既存ファイルを書き換える必要があり、team profile とも役割が異なる。

名前付き profile や config 用の環境変数を導入すると、team profile との混同や別の名前解決規則が増える。利用者は起動時に任意の config ファイルを直接指定できればよい。

## Decision

- `ensemble issue` と `ensemble operator-agent` は `--config <path>` を受け付け、共通の `loadEnsembleConfig` に指定する。
- 設定層はコード内 default → user config → project config → 明示指定 config の順に deep merge する。明示ファイルは user / project config の置き換えではなく追加 overlay とし、未記載キーを下位層から引き継ぐ。
- 設定項目ごとの優先順は CLI の項目値 → 環境変数 → 明示指定 config → project config → user config → コード内 default とする。`conductor.backend` は従来どおり profile の値を merged config より優先する。
- `--config` の相対パスはプロセスの current working directory 基準で解決し、`~` と `~/...` を home に展開する。指定ファイルが存在しなければ起動時にエラーとする。
- `--config` は team profile の `--profile` とは独立させる。config 用の名前解決・環境変数は追加しない。
- config の識別子や digest は session sidecar に記録しない。resume は起動時に指定された config を使い、既存の backend / ACP spawn 整合性検証を適用する。

## Consequences

### 良い点

- 一回の起動でモデル、ACP preset / env、その他の harness 設定を切り替えられる。
- 部分 config を使えるため、変更項目以外の既定を維持できる。
- team profile、Codex profile、ensemble config の役割が独立したまま保たれる。

### トレードオフ

- merge 後の項目は、従来どおり resume 時の backend / ACP spawn 検査で不一致を検出する。conductor model だけの変更は config 不一致として検出しないため、model や ACP 設定を切り替えて続行する場合は新しい session を推奨する。
- `acp.env` を含め config に秘密値を平文で記録しない運用は従来どおり。認証値は環境変数または provider の認証ストアで管理する。
