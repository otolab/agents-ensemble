# 開発環境

> **正本:** 本リポジトリのローカル開発・テスト・worktree のセットアップ。

## 前提

Node.js 22 と、ルート `package.json` の `packageManager` に指定された pnpm を使用する。Corepack も利用できる。

```bash
corepack enable   # 初回のみ（任意）
pnpm install
pnpm build
pnpm ensemble --help
```

`@agents-ensemble/core` をライブラリとして利用する場合:

```bash
pnpm add @agents-ensemble/core
```

## git worktree と依存インストール

`ensemble issue` の isolated モードは Issue ごとに `.ensemble/worktrees/issue-N` を切る。各 worktree は独自の `node_modules` が必要。

このリポジトリは pnpm の **global virtual store**（`enableGlobalVirtualStore`）を有効にしている。メイン worktree で一度 install した後は、同一マシン上の 2 本目以降の worktree で install がほぼ symlink の張り替えだけになる（[pnpm: Git Worktrees](https://pnpm.io/git-worktrees)）。

```bash
# メイン worktree（初回または lockfile 更新後）
pnpm install

# Issue worktree など、別 worktree に入った後
cd .ensemble/worktrees/issue-42
pnpm install --frozen-lockfile
```

正常終了した isolated session の worktree は自動削除される。未コミット変更がある場合は削除されず、ローカルブランチ `ensemble/issue-N` は残る。

## テスト

テストレベルの定義と使い分けは [testing-strategy.md](testing-strategy.md) を参照する。

```bash
# unittest（CI 必須）
pnpm test:run

# integration（fake / in-process smoke は設定不要、実 agent acp 経路は test-acp.yaml と利用可能な agent command が必要）
pnpm test:integration

# CLI 縦切り e2e（実 ACP 設定を使うシナリオと、認証不要の Pi + stdio MCP PTY teardown fixture）
pnpm test:e2e
```

integration は fake / in-process、実 ACP、実 Cursor SDK の経路に分かれる。`session-resume.integration.test.ts` や `pi-conductor.integration.test.ts` は fake / in-process 経路の例で、外部認証なしで実行できる。`codex-model-reasoning.integration.test.ts` は optional dependency の codex-acp と Codex を隔離環境で起動し、ダミー認証で設定の適用を確認する。モデルへの問い合わせは行わない。`conductor-agent.integration.test.ts` と `issue-session.integration.test.ts` は実 Cursor SDK 経路で、Cursor の保存済みログインまたは `CURSOR_API_KEY` がある場合に実行され、integration 共通 setup が一時 HOME に状態を隔離する（認証がない場合やサンドボックスで一時 HOME を作成・書き込みできない場合は理由付きで skip）。CI で常時実行する integration suite の一覧と前提条件は [testing-strategy.md](testing-strategy.md) を参照する。

Ink / React / `ink-testing-library` の更新、または TUI の resize 配線を変更する場合は、3 系統の回帰ゲートと判定基準を [Ink / React アップグレード回帰手順](tui-ink-upgrade.md) に従って確認する。

integration / e2e の設定を初めて作る場合:

```bash
cp packages/core/test/integration/test-acp.yaml.example \
   packages/core/test/integration/test-acp.yaml
```

`test-acp.yaml` が必要な実 agent ACP integration / e2e は、設定ファイルに指定した `agentCommand`（省略時は PATH 上の `agent`）が実行可能であることも必要とする。CLI suite は `issueUrl` / `repoRoot` なども環境に合わせて設定してから実行する。skip 条件と再実行方法を含む詳細は [testing-strategy.md](testing-strategy.md) に記載している。Pi + stdio MCP の TTY `/exit` teardown と `/close` resume の process fixture はローカル fake model / GitHub 応答を使い、外部認証は不要。Python 3 の標準 `pty` モジュールと localhost bind が必要で、Windows では skip する。

ローカルセッションを確認する場合は、ビルド後に次を実行する。詳細なオプションや利用者向け手順は [cli/README.md](cli/README.md) を参照する。

```bash
ensemble issue <issue-url> --repo-root <path>
```

### SSH 先の tmux で Issue session を起動する

ローカル側では Bash 3.2 以降と OpenSSH 互換 client または Google Cloud CLI が必要です。`scripts/remote-ensemble-issue.sh` は、接続先に clone・install 済みの repository、`ensemble`、`tmux` がある前提で、指定ディレクトリから `ensemble issue` を起動します。この script は npm package には含めず、repository checkout から実行します。

OpenSSH 互換 client の例:

```bash
export ENSEMBLE_REMOTE_SSH='ssh -J bastion user@dev-host'
scripts/remote-ensemble-issue.sh /srv/agents-ensemble 687 -- --verbose
```

Google Cloud CLI の例:

```bash
export ENSEMBLE_REMOTE_SSH='gcloud compute ssh --zone "us-central1-b" "naoto-kato-devbox" --project "plaid-devenv-ai"'
scripts/remote-ensemble-issue.sh /home/naoto.kato/otolab/agents-ensemble 127
```

`remote-dir` は接続先の SSH login directory からの相対 path、または absolute path です。`~` は展開しないため、home 配下を指定する場合は相対 path か absolute path を使います。

`ENSEMBLE_REMOTE_SSH` には実行ファイルと引数を指定します。空白で引数を分け、引用符と backslash で空白を含む値をまとめられます。これらは argv を組み立てるための構文としてだけ扱います。変数展開や `$(...)` などの command substitution、pipeline は実行しません。shell alias や環境変数代入も使わず、必要な環境変数は script 呼び出し前に設定してください。

OpenSSH 互換 client では接続先を最後に置きます。`ssh -J bastion user@dev-host`、`ssh -p 2222 user@dev-host` のほか、空白を含む option は引用符でまとめるか `~/.ssh/config` に設定できます。Google Cloud CLI は `gcloud compute ssh`、`gcloud alpha compute ssh`、`gcloud beta compute ssh` に対応します。script は gcloud の `--command` と `--ssh-flag` を使い、`--zone` や `--project` の値を接続先と誤認しません。環境変数内に `--` がある場合は、gcloud の追加 SSH 引数との区切りより前に script の option を追加します。詳細は [gcloud compute ssh のリファレンス](https://docs.cloud.google.com/sdk/gcloud/reference/compute/ssh)を参照してください。その他の client wrapper は OpenSSH 互換の「接続先が最後、リモート command を接続先の後に渡す」形式が必要です。

TTY は script が自動で選びます。手動で OpenSSH の `-t` / `-T`、gcloud の `--command`、TTY 用の `--ssh-flag` を指定しないでください。Issue は番号、`#番号`、GitHub Issue URL を指定できます。追加の `ensemble issue` 引数は script 呼び出しの `--` の後に置くと、空白や shell 記号を含めてそのまま渡されます。`ENSEMBLE_REMOTE_ENSEMBLE` でリモートの実行ファイル path を指定でき、省略時は `ensemble` を PATH から探します。

ローカルの stdin と stdout が両方 TTY の場合は OpenSSH に `-t`、gcloud に `--ssh-flag=-t` を渡して tmux に attach します。それ以外は `-T` 相当で detached 起動し、接続成功後に再実行用の command を stderr に表示します。同じ directory と Issue で再実行・同時実行しても、同じ tmux session を使って二重起動を防ぎます。

新規起動前に remote executable の存在と実行権限を確認し、session 作成または再利用後は約1秒待って session と pane の生存を確認します。起動できない、または確認中に終了した場合は非ゼロで終了し、ready とは表示しません。この確認は起動直後の失敗を検出するもので、その後の process の継続までは保証しません。session 名は directory の basename の英数字・`_`・`-` 以外を `-` に置き換えた値と Issue 番号から作ります。同じ basename、または置換後の値が一致する別 directory は同じ session 名になります。

接続先の非対話 SSH 環境から `ensemble`・`tmux` と必要な認証設定を利用できることを確認してください。追加 prompt がない接続を推奨します。mock test は引用符付き gcloud argv、remote command / TTY option の配置、再実行、同時起動、executable の欠落・実行不可、起動直後の終了を確認します。fake gcloud は認証や実接続を行わず、gcloud CLI 自体の option parser や実環境の SSH / tmux / terminal 設定も検証しません。利用環境では、TTY から起動して tmux を detach した後に再接続できることと、TTY のない実行が detached session を残すことを手動確認してください。

## リリース

パッケージ変更を含む PR には changeset を追加する。手順は [prompts/release.md](prompts/release.md)、changeset の概要は [.changeset/README.md](../.changeset/README.md) を参照する。

## ブランチ運用（エージェント向け注意）

| 種類 | マージ先 | 備考 |
|------|----------|------|
| **通常の PR**（機能・修正・docs・changeset 追加） | **main** | パッケージ変更時は changeset 必須 |
| **Release PR**（CI 自動生成） | **main** | `release/X.Y.Z` → main。マージで npm 公開・GitHub Release |

**エージェントがしてはいけないこと**:

- 通常 PR の base を `release/*` にする（changeset の正本は main）
- **main への merge・push**（利用者が明示したときのみ）
- Release PR のマージ（リリース判断は人間）
