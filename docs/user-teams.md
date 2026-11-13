# ユーザ定義 team profile（`~/.ensemble/teams/`）

> **正本:** `~/.ensemble/teams/` に置く user team profile の配置・名前解決・利用方法。profile 全体の概念と config の概要は [elements.md](elements.md) を参照します。

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

`materials` は `kinds` を省略すれば全 agent 共通になり、例えば `id: team-implementer`、`file: team-implementer.md`、`kinds: [implementer]` を指定すれば該当 kind の Prepared Materials にだけ同梱されます。`kinds` に指定できるのは profile の `agents` または `workers[].kind` に定義した kind で、空配列や重複指定は無効です。

## worker modelTag と tier の慣習

`workers[].modelTag` は省略できます。組み込み team では次の4語を tier 名として使いますが、profile の `modelTag` と config の `acp.tags` key には他の非空文字列も指定できます。tag の名前自体が model の性質を変えるわけではなく、`acp.tags` から `acp.models` への mapping が実際の設定を選びます。

| tag | 組み込み team での意味 |
|-----|------------------------|
| `high` | 考える力を優先。応答が遅くてもよい |
| `default` | ふつうの基準。middle と呼んでもよい |
| `low` | 軽くて安価な model を選び、速さを優先 |
| `lite` | default 相当の model に短めの reasoning を指定するなど、throughput を優先。小さい model 専用の名前ではない |

`default` 以外の選択 tag が `acp.tags` にないと harness は warning を出し、`default` の mapping を試します。それも未登録なら model を注入せず、ACP preset の既定 model に委ねます。worker が `modelTag` を省略したときは暗黙の `default` から warning なしで preset の既定へ進みます。`modelTag: default` を明示して mapping がない場合は warning を出して preset の既定を使います。`lite` は worker の tier 名で、Cursor ACP の fast mode（`cursorFast`）を有効にする指定ではありません。Cursor の model / reasoning 設定は [config.md](config.md#acp-model-tag-と-model-catalog) を参照してください。

## 一覧

```bash
ensemble profiles list
ensemble profiles list --json
```

各エントリの `id` は `name@source` 形式（例: `my-pair@user`）です。`workers[].workspace` が存在しない（またはディレクトリでない）profile は `availability: unusable` として表示され、`--profile` では起動できません。

## worker の workspace

別リポジトリやホーム配下のディレクトリを ACP cwd にしたいとき、`workers[].workspace` に `~/Develop/my-repo` のように `~` を使えます（シェルと同様に homedir() で展開）。詳細は [elements.md](elements.md) § プロファイル を参照。

## 組み込み default

同梱の標準 team は v2 の `profiles/implementer-and-reviewer-v2/`（内部名 `implementer-and-reviewer-v2`）です。CLI・環境変数・config に profile の指定がない場合と、`--profile default` はこの v2 を指します。v1 の `implementer-and-reviewer` も同梱されており、`--profile implementer-and-reviewer` で明示的に選べます。シェル全体またはリポジトリ単位のデフォルトは `ENSEMBLE_DEFAULT_PROFILE` または config の `profile.default` で指定できます（CLI `--profile` が優先）。全体の解決順は [settings.md](settings.md) の profile 設定を参照してください。

詳細は [elements.md](elements.md) § プロファイル と [ADR 0018](adr/0018-team-profile-four-layer-resolution.md) を参照してください。
