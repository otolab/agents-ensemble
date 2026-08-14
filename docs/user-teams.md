# ユーザ定義 team profile（`~/.ensemble/teams/`）

複数リポジトリで共通のチーム体制を使うとき、ホームディレクトリ配下に team profile を置けます。

## 配置

```
~/.ensemble/teams/<name>/
  profile.yaml      # 必須。workers / agents / materials と同スキーマ
  team.md           # 任意。materials から参照
  *.prompt.yaml     # 任意。agents.<kind>.promptFile から参照
```

`<name>` は `--profile <name>` で指定する識別子です。

## 優先順

名前のみの `--profile <name>` は次の順で解決されます（上位が勝ちます）。

1. `<repo>/.ensemble/teams/<name>/profile.yaml`（プロジェクト）
2. `~/.ensemble/teams/<name>/profile.yaml`（ユーザ）← 本ドキュメント
3. 同梱 `profiles/<name>/profile.yaml`
4. `<repo>/profiles/<name>/profile.yaml`（レガシー・非推奨）

## 最小例

`~/.ensemble/teams/my-pair/profile.yaml`:

```yaml
meta:
  title: 実装 + レビュー（ユーザ共通）
  summary: 小さめの PR 向け 2 者体制
workers:
  - name: implementer
    kind: implementer
  - name: reviewer
    kind: reviewer
materials:
  - file: team.md
agents:
  conductor:
    promptFile: conductor.prompt.yaml
```

利用:

```bash
ensemble issue 42 --profile my-pair
```

## 一覧

```bash
ensemble profiles list
ensemble profiles list --json
```

各エントリの `id` は `name@source` 形式（例: `my-pair@user`）です。

## 組み込み default

同梱の標準 team は `profiles/implementer-and-reviewer/`（内部名 `implementer-and-reviewer`）です。`--profile` 省略時および `--profile default` は同じプロファイルを指します。シェル全体のデフォルトにする場合は `export ENSEMBLE_DEFAULT_PROFILE=<name>` を使えます（CLI `--profile` が優先）。

詳細は [elements.md](elements.md) § プロファイル と [ADR 0018](adr/0018-team-profile-four-layer-resolution.md) を参照してください。
