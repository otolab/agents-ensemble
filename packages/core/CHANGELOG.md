# @agents-ensemble/core

## 0.1.1

### Patch Changes

- 9d2863c: `js-yaml` を core の runtime dependencies に移し、グローバル install 後の `ensemble` 起動を修正

## 0.1.0

### Minor Changes

- d5ce3ef: npm 公開と changeset ベースのリリースフロー（modular-prompt 踏襲）を整備

### Patch Changes

- 124bdba: publish 時に prepublishOnly が dist を再生成するよう tsc --build --force を使う
