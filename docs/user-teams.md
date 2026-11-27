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
  modes: [issue]
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

`workers[].modelTag` は省略できます。組み込み team では次の4語を tier 名として使いますが、profile の `modelTag` と config の `acp.tags` key には空文字・空白のみを含む任意の文字列を指定できます。空文字 tag は profile で `modelTag: ""`、config の `acp.tags` では `"": blank` のように YAML の引用符で表します。tag の名前自体が model の性質を変えるわけではなく、`acp.tags` から `acp.models` への mapping が実際の設定を選びます。

| tag | 組み込み team での意味 |
|-----|------------------------|
| `high` | 考える力を優先。応答が遅くてもよい |
| `default` | ふつうの基準。middle と呼んでもよい |
| `low` | 軽くて安価な model を選び、速さを優先 |
| `lite` | default 相当の model に短めの reasoning を指定するなど、throughput を優先。小さい model 専用の名前ではない |

`default` 以外の選択 tag（空文字・空白のみを含む）が `acp.tags` にないと harness は warning を出し、`default` の mapping を試します。それも未登録なら model を注入せず、ACP preset の既定 model に委ねます。worker が `modelTag` を省略したときは暗黙の `default` から warning なしで preset の既定へ進みます。`modelTag: default` を明示して mapping がない場合は warning を出して preset の既定を使います。`lite` は worker の tier 名で、Cursor ACP の fast mode（`cursorFast`）を有効にする指定ではありません。Cursor の model / reasoning 設定は [config.md](config.md#acp-model-tag-と-model-catalog) を、空文字を含む tag の扱いは [ADR 0064](adr/0064-worker-model-tags-allow-empty-strings.md) を参照してください。

## 一覧

```bash
ensemble profiles list
ensemble profiles list --json
```

`meta.modes` は対応する入口を `[issue]`、`[run]` または `[issue, run]` で宣言します。省略は未指定であり、既存 profile の起動動作は変わりません。宣言は選択の目安で、異なる入口からの実行を制限しません。空配列、重複、未知の値は不正で load 時に拒否されます。一覧 text の `modes` と JSON の `modesStatus` は宣言済み・未指定・不正を区別します。

各エントリの `id` は `name@source` 形式（例: `my-pair@user`）です。`workers[].workspace` が存在しない（またはディレクトリでない）profile は `availability: unusable` として表示され、`--profile` では起動できません。

## worker の workspace

別リポジトリやホーム配下のディレクトリを ACP cwd にしたいとき、`workers[].workspace` に `~/Develop/my-repo` のように `~` を使えます（シェルと同様に homedir() で展開）。詳細は [elements.md](elements.md) § プロファイル を参照。

## 組み込み default

同梱の標準 team は v2 の `profiles/implementer-and-reviewer-v2/`（内部名 `implementer-and-reviewer-v2`）です。CLI・環境変数・config に profile の指定がない場合と、`--profile default` はこの v2 を指します。v1 の `implementer-and-reviewer` も同梱されており、`--profile implementer-and-reviewer` で明示的に選べます。シェル全体またはリポジトリ単位のデフォルトは `ENSEMBLE_DEFAULT_PROFILE` または config の `profile.default` で指定できます（CLI `--profile` が優先）。全体の解決順は [settings.md](settings.md) の profile 設定を参照してください。

詳細は [elements.md](elements.md) § プロファイル と [ADR 0018](adr/0018-team-profile-four-layer-resolution.md) を参照してください。

## 組み込み with-architect

同梱の `profiles/with-architect/`（`--profile with-architect`）は、v2 の conductor / implementer / reviewer に、設計相談役の worker `architect`（`modelTag: high`、`workspace` 指定なし）を加えた team です。`ensemble issue <N> --profile with-architect` で起動します。

architect は、渡された情報から推論して設計上の助言を返す相談役です。前提の誤り、情報の矛盾、語られていない空白を指摘し、分からないことは「不明」と答えたうえで、何を調べれば判断できるかを返します。コードを書くこと、探索的な調査、判定や承認、Issue / PR への投稿はしません。ツールの使用はなるべく控え、推論の裏付けに要る特定のコード箇所の確認と、指定されたドキュメントの読み込みにとどめます。

- **相談の経路:** worker どうしは直接やりとりしません。conductor が方針の分かれ目、難しいところ、レビューで出た設計上の指摘、実装が方針からずれていそうなときに、判断に要る情報を指示文にまとめて architect に渡します。助言は conductor が咀嚼して判断し、implementer / reviewer に伝えます。相談したことと採用した判断は conductor が Issue に残します。
- **制約の強さ:** architect の制約は materials（`team-architect.md`）での宣言だけです。worker ごとのツール allowlist や読み取り専用の設定はなく、仕組みとしては他の worker と同じ権限で動きます。書き込みを伴う permission 要求が来た場合は conductor が deny します。
- **attach の時期:** `session.lazyWorkers` が既定の `false` のときは、architect も他の worker と同じくセッション開始時に attach します。相談するまで起動を遅らせたい場合は `session.lazyWorkers: true` を設定してください（[config.md](config.md) の `session.lazyWorkers`）。この設定は profile の全 worker に適用されます。
- **modelTag:** `high` の mapping が `acp.tags` にない場合は warning を出して `default` を試します（上記「worker modelTag と tier の慣習」）。
