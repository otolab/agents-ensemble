# ADR 0066: Issue ごとの builtin Pi worker 保存先と権限

- Status: accepted
- Date: 2026-11-13
- Supersedes in part: [ADR 0063](0063-pi-acp-upstream-package-wrapper.md)（builtin worker の保存先の分離単位のみ）
- Related: [ADR 0064](0064-builtin-pi-home-and-resume-safety.md), [Issue #670](https://github.com/otolab/agents-ensemble/issues/670)

## Context

upstream `pi-acp@0.0.34` の session map path は ACP process の `HOME` から決まり、map 全体を read-modify-write する。既存の repo・worker 単位の保存先では、同じ repository で別 Issue を同時に処理する同名 worker が map を共有する。二つの adapter process が同じ map を読み込んでから更新すると、後の書き込みが先の session entry を消す可能性がある。

また、upstream adapter と Pi CLI が新しく作る map / transcript の既定 mode は process の umask に従う。一般的な `umask 022` では会話 transcript が group / other から読める mode になる場合があり、既存 builtin worker storage にも owner-only mode を直す処理がなかった。

## Decision

- builtin worker の adapter `HOME` と transcript directory は `~/.ensemble/pi/worker/<repoKey>/issue-<issueNumber>/<workerKey>/` に置く。Issue 番号を含め、同じ repository の別 Issue では map と transcript を共有しない。Pi settings / credential root は引き続き `conductor.pi.agentDir` と共有し、BYO の保存先は変えない。
- Issue ごとの upstream map がまだない場合は、旧 repo・worker 共有 storage の map を `COPYFILE_EXCL` でコピーする。旧 map と transcript は移動・削除せず、古い map entry が指す transcript path を維持する。history reader は SessionResumeStore の `issueUrl` から Issue path を選び、そこに entry がなければ旧共有 map も読む。
- builtin wrapper は upstream adapter を読み込む前に POSIX process の umask を `077` にする。builtin worker storage root 以下にある既存 directory は `0700`、既存 file は `0600` に直す。新しく作られる map / transcript も umask によって owner read/write に制限する。symlink または通常 file / directory 以外を storage tree 内で見つけた場合は、別の保存先を誤って変更しないよう起動を失敗させる。
- Windows では Node.js の file mode 指定で ACL を設定・検査しない。Windows の owner-only access は保証せず、利用者は user root の親 ACL を管理する。
- upstream `session/list` が worker の `PI_CODING_AGENT_SESSION_DIR` を探索しない制約は変わらない。map-backed `session/load` と history reader を使い、map を失った場合は従来どおり resume を fail closed にする。

## Consequences

- 別 Issue の同名 worker はそれぞれ独立した map を更新するため、upstream の map 全体上書きで session entry が互いに消えることはない。
- 既存 builtin session は旧 map のコピーと元の transcript path を使って読み込み・resume できる。移行後も旧 map / transcript は残る。BYO と builtin の runtime marker、認証 root、`session/list` の map-less discovery 制約は変わらない。
- POSIX では新規・既存 builtin session data の mode bits を owner-only にする。Windows は保存先 ACL の確認が別途必要である。
