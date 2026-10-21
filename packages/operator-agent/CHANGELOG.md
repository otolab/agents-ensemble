# @agents-ensemble/operator-agent

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
