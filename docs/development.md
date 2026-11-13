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

`gcloud compute ssh --command` は通常 non-interactive shell で remote command を実行します。Google の例では、対話環境を使うには `bash -i -c` のように shell 自体を明示し、SSH に `-t` を渡しています。この script は tmux attach 用の PTY を確保するため `-t` を付けますが、対話 shell は起動しません。そのため、nvm などを shell 初期化ファイルで有効にしていると、対話 shell では見つかる `ensemble` が script の起動時には PATH にないことがあります。[gcloud の仕様](https://docs.cloud.google.com/sdk/gcloud/reference/compute/ssh)を参照してください。

新規 session の起動で `remote executable not found or not executable` が出た場合、この script の事前確認が tmux pane を作る前に失敗しています。まず SSH remote command の PATH から `ensemble` が見えるかを確認してください。absolute path を指定してこの確認を通した後も pane がすぐ終了する場合は、Node の shebang interpreter など実行時に必要なものが tmux 側の PATH にあるか確認します。

tmux は server 起動時の global environment と session environment から pane の環境を組み立てます。`update-environment` に含めた変数は client から更新されますが、既定のリストに `PATH` は含まれません。すでに動いている tmux server が古い PATH を持っている場合もあるため、`tmux show-environment -g PATH` と `tmux show-environment -t agents-ensemble-127 PATH` で確認できます（[tmux の環境変数仕様](https://man.openbsd.org/tmux.1#GLOBAL_AND_SESSION_ENVIRONMENT)、[既定の update-environment](https://github.com/tmux/tmux/blob/master/options-table.c#L1242-L1251)）。

Node version manager を使う場合は、リモートで起動する wrapper に必要な Node の bin directory を PATH へ足し、その wrapper を `ENSEMBLE_REMOTE_ENSEMBLE` に指定すると安定します。たとえば nvm 配下に global install した `ensemble` なら、SSH 先で次の wrapper を作ります（Node の version directory は実際の環境に合わせてください）。

```sh
mkdir -p "$HOME/bin"
cat > "$HOME/bin/ensemble-with-node" <<'EOF'
#!/bin/sh
node_bin="$HOME/.nvm/versions/node/v22.14.0/bin"
PATH="$node_bin:$PATH"
export PATH
exec "$node_bin/ensemble" "$@"
EOF
chmod +x "$HOME/bin/ensemble-with-node"
```

wrapper 自体は `/bin/sh` など固定パスの interpreter で起動し、`node` を必要とする `ensemble` を実行する前に PATH を整えます。nvm の shell 初期化や tmux server が保持している PATH に頼らず、pane 内で実行環境を補えます。`ENSEMBLE_REMOTE_ENSEMBLE` には wrapper のリモート側 absolute path を設定してください。`$HOME` は script が展開しないため、値にはリモートの実 path を使います。実行ファイルがすでに non-interactive SSH と tmux の両方から使えるなら、wrapper は不要です。

```bash
export ENSEMBLE_REMOTE_ENSEMBLE='/home/your-user/bin/ensemble-with-node'
scripts/remote-ensemble-issue.sh /srv/agents-ensemble 687
```

#### mise を使う場合

非対話 SSH command や tmux pane では、対話 shell の起動設定に書いた `mise activate` が実行されるとは限りません。wrapper から mise を絶対 path で直接呼び、`mise exec -C` に pane の作業 directory を渡してください。mise はその directory と親 directory の config を読み、選択した tool と環境変数を子 process に設定します。`exec` と `"$@"` により、引数を分割せず mise へ渡し、wrapper の終了 status も引き継ぎます（[mise exec](https://mise.jdx.dev/cli/exec)、[mise config の探索](https://mise.jdx.dev/configuration)）。

まず接続先の対話 shell で mise の実体と directory 設定を確認し、repository の config を確認したうえで必要な Node version を install します。`mise exec` は不足 tool を自動 install する設定が既定なので、pane 起動時に初回 install や network access が起きないよう先に済ませてください。config の trust error が出る場合は、内容を確認して対話 shell から `mise trust` を実行します。paranoid mode では自動 trust されません（[mise trust](https://mise.jdx.dev/cli/trust)）。

```sh
repo_dir=/home/your-user/otolab/agents-ensemble
command -v mise
cd "$repo_dir"
mise doctor
unset MISE_NODE_VERSION MISE_ENV
mise config
mise ls --current
mise install
mise exec -C "$repo_dir" -- sh -c 'node --version; command -v ensemble'
```

次の wrapper は Linux の mise 標準 directory を使う例です。`mise doctor` と `command -v mise` の結果に合わせて、実際の `HOME`、mise executable、config / data / state / cache directory に置き換えてください。既存 tmux server は後から接続した shell の全 environment を取り込むわけではありません。Node version を repository config に選ばせる場合は、古い server environment から引き継いだ `MISE_NODE_VERSION` を消します。named environment を使う場合は、ここで正しい `MISE_ENV` を設定してください。

```sh
mkdir -p "$HOME/bin"
cat > "$HOME/bin/ensemble-with-mise" <<'EOF'
#!/bin/sh
set -eu

HOME=/home/your-user
MISE_CONFIG_DIR="$HOME/.config/mise"
MISE_DATA_DIR="$HOME/.local/share/mise"
MISE_STATE_DIR="$HOME/.local/state/mise"
MISE_CACHE_DIR="$HOME/.cache/mise"
MISE_INSTALLS_DIR="$HOME/.local/share/mise/installs"
mise_bin=/home/your-user/.local/bin/mise
export HOME MISE_CONFIG_DIR MISE_DATA_DIR MISE_STATE_DIR
export MISE_CACHE_DIR MISE_INSTALLS_DIR

unset MISE_NODE_VERSION MISE_ENV
repo_dir=$(pwd -P)
exec "$mise_bin" exec -C "$repo_dir" -- ensemble "$@"
EOF
chmod +x "$HOME/bin/ensemble-with-mise"
```

`unset MISE_ENV` は base config を使う場合の例です。`mise.<env>.toml` などを使う場合は削除し、必要な `MISE_ENV` を wrapper 内で明示してください。選択中の config が Node version を指定しない場合は `unset MISE_NODE_VERSION` を削除し、意図した version を wrapper で設定します。逆に repository config に Node を選ばせる場合は、古い version override を残さないでください。`MISE_NODE_VERSION` は config の指定より優先されます。独自の `MISE_*_DIR` や XDG directory を使う場合も、その値を wrapper に明示してください（[mise の directory 設定](https://mise.jdx.dev/directories.html)、[MISE_* 環境変数](https://mise.jdx.dev/configuration/environment-variables.html)）。

```bash
export ENSEMBLE_REMOTE_ENSEMBLE='/home/your-user/bin/ensemble-with-mise'
scripts/remote-ensemble-issue.sh /home/your-user/otolab/agents-ensemble 687
```

この wrapper は絶対 path の mise から `mise exec` を起動し、Node の bin directory を含む PATH を子 process に設定してから `ensemble` を探します。事前確認の `command -v ensemble` が失敗する場合は、mise の環境から見える `ensemble` の実行 path を調べて、wrapper の `ensemble` をその absolute path に置き換えてください。`ensemble` が `#!/usr/bin/env node` を使う場合も、Node を選ぶ mise の PATH は必要です。wrapper を変更したあと同じ Issue session がすでに存在すると、script は wrapper を再実行せずその session に接続します。再試行時は対象 session の状態を確認してください。

ローカルの stdin と stdout が両方 TTY の場合は OpenSSH に `-t`、gcloud に `--ssh-flag=-t` を渡して tmux に attach します。それ以外は `-T` 相当で detached 起動し、接続成功後に再実行用の command を stderr に表示します。同じ directory と Issue で再実行・同時実行しても、同じ tmux session を使って二重起動を防ぎます。

新規起動前に remote executable の存在と実行権限を確認し、session 作成または再利用後は約1秒待って session と pane の生存を確認します。実行ファイルが見つからない場合は `ENSEMBLE_REMOTE_ENSEMBLE` の設定を案内します。起動できない、または確認中に終了した場合は非ゼロで終了し、ready とは表示しません。この確認は起動直後の失敗を検出するもので、その後の process の継続までは保証しません。session 名は directory の basename の英数字・`_`・`-` 以外を `-` に置き換えた値と Issue 番号から作ります。同じ basename、または置換後の値が一致する別 directory は同じ session 名になります。

接続先の非対話 SSH 環境から `ensemble`・`tmux` と必要な認証設定を利用できることを確認してください。追加 prompt がない接続を推奨します。mock test は引用符付き gcloud argv、remote command / TTY option の配置、再実行、同時起動、remote PATH に `ensemble` がない場合の失敗、Node が PATH にない pane での起動失敗と wrapper による復旧、起動直後の終了を確認します。fake gcloud は認証や実接続を行わず、gcloud CLI 自体の option parser や実環境の SSH / tmux / terminal 設定も検証しません。利用環境では、TTY から起動して tmux を detach した後に再接続できることと、TTY のない実行が detached session を残すことを手動確認してください。

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
