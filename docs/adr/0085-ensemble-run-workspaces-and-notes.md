# ADR 0085: `ensemble run`、workspaces 永続化、Notes

- Status: accepted
- Date: 2026-11-21
- Related: [Issue #821](https://github.com/otolab/agents-ensemble/issues/821)

## Context

`ensemble issue` は GitHub Issue を作業の正本とし、canonical slug 配下の `~/.ensemble/sessions/github.com/<owner>/<repo>/` に harness 状態を保存する（[ADR 0061](0061-github-slug-session-persistence.md)）。conductor–worker モデル、ACP、permission、Open Question、team profile による役割分担は、Issue 以外の作業形態にも使える。

一方で次の用途は Issue / GitHub を前提にしにくい。

- 起動 cwd に閉じた調査と資料整理
- 明確な受け入れ条件や PR マージをゴールにしない長期作業
- GitHub remote を想定しないローカルリポジトリ

`ensemble issue` と harness 本体の多くは共有できる。本質的な分岐は **GitHub（Issue 文脈・monitor）を使うかどうか**である。Issue なしでは、時系列の記録と一覧用の要約を **Notes（ノートとメモ履歴）** で補う。

既存の `sessions/` ツリーに cwd ベースのデータを混在させると、`ensemble session list` や operator-agent の Issue 前提の索引と衝突する。また保存先を `github.com/<owner>/<repo>` slug にすると remote 必須になる。repo 階層は不要とする。

worktree isolated は Issue 作業の隔離に向く。新モードは **起動時 cwd で閉じ、worktree を作らない**（既存の `in_repo` 相当）でよい。

チーム編成（例: conductor + explore + librarian）は harness が固定しない。デフォルトの implementer/reviewer プロフィールは Issue 用の例であり、新モード用プロフィールは別物として 0 から書く。成果物の置き場所や書き方は team profile materials に書く。base プロンプトの Issue 前提は ticket 用モジュールとして切り出す方針とする（本 ADR の実装範囲外でよい）。

## Decision

### CLI とモードの対

| 入口 | 外部正本 | 初期指示 |
|------|----------|----------|
| `ensemble issue` | GitHub Issue / PR（monitor 可） | Issue URL |
| `ensemble run` | なし | **プロンプト用ファイル**（＋ TTY オペレータ入力） |

両者は同じ conductor session コアを共有する。`ensemble run` では GitHub Issue context 取得と GitHub monitor を既定で無効にする。

### 永続化: `workspaces/` と Issue の `sessions/` の分離

- Issue モード: 従来どおり `~/.ensemble/sessions/github.com/<owner>/<repo>/` のみ（変更しない）。
- `ensemble run`: **`~/.ensemble/workspaces/<slug-key>/`** に保存する。`sessions/` とは別ルートとし、一覧 API も分ける。
- **git remote や repository slug はパス設計の前提にしない**。repo 用の中間ディレクトリは設けない。

### slug（Issue の canonical slug に相当するキー）

- **slug-key** は `workspaces/` 直下のディレクトリ名であり、当該作業場の保存名前空間である（1 回の conductor run の `conductorAgentId` とは別）。
- **無名時**: 正規化した cwd の絶対パスから導出するハッシュを slug-key とする。
- **明示名**: 利用者が付けた名前を slug-key とする。付け替えは **`workspaces/<old>/` を `workspaces/<new>/` へリネーム**する（エイリアスではなくキーのリネーム）。衝突時は拒否する。
- **cwd 結び**: 作業ディレクトリにアンカーファイルを置き、現在の slug-key を記録する。例: `<cwd>/.ensemble/workspace.json` に `{ "slug": "<slug-key>" }`。リネーム時はディレクトリとアンカーを同時に更新する。
- slug-key の正規化ルール（realpath、末尾スラッシュ、禁止文字、長さ）は実装時に固定する。

### Harness 実行コンテキスト

- **ACP cwd**: 起動時の cwd（全 worker 共通。profile の per-worker `workspace` で別 cwd を指定しないことが既定）。
- **worktree**: 新規 worktree を作らない。既存の `WorkerWorktreeMode` の `in_repo` 経路を用い、worktree 周りの実装は極力変更しない。
- **resume / run 単位**: Issue と同様、slug 配下に `runs/`（または同等）で `conductorAgentId` ごとの SessionResumeStore 等を保持する。Notes は **slug 単位で共有**し、同一作業場での `--continue` 後もノートが残る。

### Notes（ノートとメモ）

GitHub Issue コメント・description に相当する時系列と一覧用要約を harness が提供する。

**ノート**

- 作成時に **summary（短い見出し）を必須**とする。自動見出しは使わない。
- リストはノート単位でページングする。既定では **アーカイブ済みノートを含めない**（明示フラグで含める）。
- リスト各行: ノートの **summary** と、**最新メモの先頭数百字**（全文は載せない）。

**メモ（ノートごと）**

- **追記のみ**（上書きしない）。時系列履歴を保持する。
- **既定の read**: 最新メモ 1 件のみ。履歴はページングで取得する。
- ノートおよびメモのエントリ単位で **archive** 可能（既定一覧から除外。読取は可能）。

保存先は `workspaces/<slug-key>/notes/` 配下とする（具体ファイル布局は実装時に定義する）。

チーム profile はノート／メモの**使い方**（いつ書くか、誰が書くか）を materials に書く。ストレージ API の有無やスキーマは harness の責務とする。

### プロンプトと base モジュール

- Issue 用 base の objective / GitHub 監視説明は **ticket モジュール**に切り出し、`ensemble issue` のみ merge する（別 PR 可）。
- `ensemble run` 用 team profile は Issue 語彙に依存しない materials を新規作成する（本 ADR ではパスを規定しない）。

### operator-agent と session CLI

- operator-agent の Issue session watch / `list_operator_sessions` は **Issue `sessions/` 用のまま**とし、`workspaces/` は初版では対象外とする（必要なら別 ADR）。
- `ensemble session list` は Issue 保存分。`ensemble run` 用一覧は **`ensemble run list`**（または同等の別コマンド）で `workspaces/` を列挙する。

## Consequences

### 良い点

- Issue と cwd 作業がストレージ・CLI 上で混ざらない。
- remote 不要のリポジトリでも `ensemble run` の索引が動く。
- 長期作業で GitHub コメントに頼らず、ノート／メモで時系列と一覧を維持できる。
- harness コアと profile の責務分離（編成・手順は profile、Notes は機能）が明確になる。

### トレードオフ

- slug-key の cwd ハッシュはパス変更で変わり得る。アンカーファイルと明示名が運用上の正本になる。
- worktree 隔離がないため、オペレータと worker が同一 cwd の作業ツリーを共有する。
- Notes 用 API と conductor tool の保守が必要になる。

### フォローアップ（実装の目安）

1. `resolveEnsemblePaths` に `workspacesRoot` と slug パス helper を追加。
2. `ensemble run` コマンド（brief ファイル、slug アンカー、`--continue`）。
3. Notes / memos の core 永続化と conductor tool（read / push / archive / list）。
4. ADR 0085 accepted 後、[architecture.md](../architecture.md) と [docs/cli/README.md](../cli/README.md) に `issue` / `run` の対を追記。
5. base プロンプトの ticket モジュール切り出し（任意タイミング）。

## 非スコープ（本 ADR）

- `ensemble run` の具体実装とテスト
- explore / librarian 同梱 profile の本文
- operator-agent が workspaces を watch すること
- cwd 内ファイルを正本とする成果物レイアウト（team materials 任せ）
