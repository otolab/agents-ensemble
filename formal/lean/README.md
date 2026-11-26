# Lean 形式モデルの作業規約

この独立した Lake パッケージは dispatch フローの形式モデルを置く。設計判断と段階は [ADR 0086](../../docs/adr/0086-lean-formal-model-for-dispatch-flow.md) を参照する。`packages/*` の外にあり、pnpm workspace には参加しない。

## 構成と役割

- `Ensemble.lean`: 各モジュールを読み込む入口。
- `Ensemble/Flow/Spec.lean`: As-Is と To-Be に共通する抽象仕様と性質の文面。人がレビューする中心。
- `Ensemble/AsIs/`: 現行 TypeScript の状態と遷移を忠実に写すモデル。仕様に反する場合もモデルを直さず、具体的なイベント列と日本語の説明を `Counterexamples.lean` に記録する。TS 関数との対応・抽象化・未判定の性質は [`Composition.md`](Ensemble/AsIs/Composition.md) に整理する。
- `Ensemble/ToBe/`: 再設計案と性質の証明。
- `Ensemble/Oracle/`: 差分テスト用の JSON-lines オラクルを置く場所。

`AsIs.lean` と `ToBe.lean` は各ディレクトリの入口として使う。モデルやオラクルの実装は必要になった段階で追加する。

## 記述と検証

- mathlib に依存しない。標準ライブラリのほかに依存を追加する場合は Batteries / Plausible までとし、バージョンを固定して manifest を更新する。
- すべての定義・定理に、意図を説明する日本語の docstring を付ける。
- 性質の文面は `Flow/Spec.lean` に置き、証明は別ファイルに置く。Lean で文面を独立させる際は命題を定義し、別ファイルの定理でその命題を証明する。文面の変更は人のレビューを受ける。
- `sorry`、`native_decide`、標準外の公理を使わない。

[elan の公式手順](https://lean-lang.org/install/)で elan を導入し、このディレクトリで次を実行する。`lean-toolchain` の固定版が使われる。

```sh
lake build
lake build -- --wfail
```

証明した各定理について、対象モジュールを import する Lean ファイルに `#print axioms 定理名` を書いて `lake env lean ファイル名.lean` を実行する。出力に含まれる公理が `propext`、`Classical.choice`、`Quot.sound` のみであることを確認する。公理への依存がない場合も許される。`sorryAx` を含むその他の公理は許されない。警告なしのビルドだけでは `native_decide` や標準外の公理を十分に検出できないため、ソースと公理の両方を確認する。

## TypeScript との対応

As-Is の変更には、対象モデルの文書または Issue に次の形式で対応表を残す。パスはリポジトリルートから記し、関数と定義を個別に対応させる。対応しない部分や抽象化も表の近くに説明する。

| TypeScript のファイル | 関数 | Lean の定義 |
|---|---|---|
| `packages/.../example.ts` | `example` | `Ensemble.AsIs.example` |

## lean-lsp-mcp

エージェントは [lean-lsp-mcp](https://github.com/project-numina/lean-lsp-mcp) を使う。elan と [uv](https://docs.astral.sh/uv/) を導入し、先にこのディレクトリで `lake build` を実行する。クライアントのローカル MCP 設定で stdio コマンドを `uvx`、引数を `lean-lsp-mcp` とし、環境変数 `LEAN_PROJECT_PATH` にこの worktree の `formal/lean` の絶対パスを設定する。設定形式や再起動方法はクライアントごとに異なるため、[上流の設定例](https://github.com/project-numina/lean-lsp-mcp#setup)を参照する。

編集後は `lean_diagnostic_messages` に対象ファイルを指定してエラー・警告を確認する。証明中は `lean_goal` にファイルと行・列を指定してその位置の証明状態を確認し、必要に応じて `lean_hover_info` で定義や型を調べる。MCP の診断に加え、上記のビルドと公理の確認を行う。
