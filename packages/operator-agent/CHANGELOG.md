# @agents-ensemble/operator-agent

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
