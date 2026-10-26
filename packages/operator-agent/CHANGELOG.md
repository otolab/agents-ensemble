# @agents-ensemble/operator-agent

## 0.4.0

### Minor Changes

- 9841ba8: repo 単位のセッション状態、operator-agent 状態、Pi transcript を `~/.ensemble/` 配下へ保存します。旧 project 保存先からの再開・読み取り互換と、`resolveEnsemblePaths` API を追加しました。
- d771eb8: `ensemble issue` と `ensemble operator-agent` で `--config <path>` を指定し、標準 user config を指定ファイルに差し替えて起動できるようにしました。project config は独立した層として引き続き適用され、同じ項目では project 側が優先されます。

  session sidecar には解決済み config の digest を記録し、resume 時に設定変更を検出します。
  worker ACP fingerprint は env の digest のみを保持し、環境変数の値を sidecar に残しません。

- 3bbabef: Build operator-agent conductor message history from saved provider sessions and keep it available after process restarts.
- 3ec2925: Report Open Question answers and disappearance from watched sessions.

### Patch Changes

- f97b815: operator-agent が Pi の認証エラー後に同じ入力を一度再試行し、TTY の `/reconnect` を専用の再接続操作として扱うようになりました。
- f90e0f1: TTY の入力プロンプトと出力チャネルを整理し、対話・harness 状態・運用通知を見分けやすくしました。
- Updated dependencies [f97b815]
- Updated dependencies [9841ba8]
- Updated dependencies [dc3db7b]
- Updated dependencies [d771eb8]
- Updated dependencies [3bbabef]
- Updated dependencies [2462261]
- Updated dependencies [5e92c4c]
  - @agents-ensemble/core@0.16.0

## 0.3.0

### Minor Changes

- 4b0c8aa: 稼働中 harness の conductor 成功応答と対応する inbound を一覧・listen できる API を追加します。
- bff70e9: operator-agent が user との会話中に watch report の dispatch を自動保留し、会話 hold と手動 report hold を独立して管理するようにしました。

### Patch Changes

- 6e0ebd8: `SessionResumeStore` 名の resume API を追加します。旧 sidecar API は deprecation を明記し、1 リリース限り alias として維持します。
- f8af5dd: Persist harness activity phases and project session resume state separately from live connectivity. `--continue` now prefers close/abort sessions and skips exit sessions.
- Updated dependencies [87ccff0]
- Updated dependencies [4b0c8aa]
- Updated dependencies [6e0ebd8]
- Updated dependencies [e798a83]
- Updated dependencies [f8af5dd]
- Updated dependencies [8163ff0]
- Updated dependencies [58a37ce]
  - @agents-ensemble/core@0.15.0

## 0.2.2

### Patch Changes

- Updated dependencies [4f4088f]
  - @agents-ensemble/core@0.14.2

## 0.2.1

### Patch Changes

- 126a304: operator-agent に複数 Issue session の watch pool、報告 batching / hold、live UDS observation と operator.message 連携を追加。
- adf9833: TTY の operator-agent 表示に余白とラベル色を加え、長い応答を読みやすくします。
- 1362632: operator-agent の会話を既定で再開し、`/exit` と `--new` で連続性を切れるようにします。
- 78b2987: Add operator message delivery modes and live UDS message sending.
- 8f21a0e: operator-agent の session watch が新規 open Open Question を検知し、重複を避けて operator へ報告する。
- b187554: 稼働中 session の UDS から最後の conductor 成功応答を取得する API と operator-agent tool を追加します。
- Updated dependencies [126a304]
- Updated dependencies [7a2fdb0]
- Updated dependencies [e5a39d9]
- Updated dependencies [78b2987]
- Updated dependencies [b187554]
- Updated dependencies [6de3ba6]
  - @agents-ensemble/core@0.14.1

## 0.2.0

### Minor Changes

- c3d6c83: 稼働中の Issue harness にセッション単位 UDS control API を追加し、operator-agent から Open Question の一覧取得と回答を行えるようにしました。終了時の dispatch drain は最大 5 秒とし、回答が保存済み・dispatch 未確認の場合は outcome unknown を返し、停止後の再送で二重回答が起きないようにします。
- c4906d7: セッションインスタンスごとの statusLine と上限付き履歴・終了 lifecycle を保存し、operator-agent の一覧取得・絞り込みに対応します。

### Patch Changes

- Updated dependencies [a35de08]
- Updated dependencies [c3d6c83]
- Updated dependencies [c4906d7]
  - @agents-ensemble/core@0.14.0

## 0.1.0

### Minor Changes

- 05168a8: `ensemble operator-agent` と独立した operator-agent package を追加しました。TTY 対話では conductor と同じ backend・model・profile・認証設定を使い、保存済み sidecar を読み取り専用ツールから参照できます。

### Patch Changes

- Updated dependencies [a19ab4a]
- Updated dependencies [05168a8]
- Updated dependencies [993b66e]
- Updated dependencies [55d2729]
- Updated dependencies [5715bc8]
- Updated dependencies [4ef2ec7]
- Updated dependencies [9eb66ba]
- Updated dependencies [c7ab17a]
- Updated dependencies [e24cb1b]
  - @agents-ensemble/core@0.13.0
