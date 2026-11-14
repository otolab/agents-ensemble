# ADR 0071: Windows で builtin Pi worker の保存先 ACL を制限する

- Status: accepted
- Date: 2026-11-14
- Supersedes in part: [ADR 0070](0070-issue-scoped-builtin-pi-storage.md)（Windows の保存権限のみ）
- Related: [Issue #670](https://github.com/otolab/agents-ensemble/issues/670)

## Context

ADR 0070 は POSIX の mode と `umask 077` を定めたが、Windows では Node.js の `chmod` / file mode が owner・group・other を区別せず、ACL を保護しない。Windows の既定 ACL が広い環境では、upstream adapter と Pi CLI が作る session map / transcript を他の OS account から読める可能性が残る。

## Decision

- Windows では wrapper が標準の `icacls.exe` で `~/.ensemble/pi/worker` と現在の repository storage tree の DACL を設定する。各対象の ACL を reset してから owner を現在の Windows account SID に揃え、継承 ACE を外し、現在の account にだけ Full Control を許可する。PowerShell の .NET filesystem ACL API で owner と ACE を読み戻して検証する。PowerShell Security module の `Get-Acl` / `Set-Acl` には依存しない。
- Directory の ACE は child file / directory に継承させる。upstream `pi-acp@0.0.34` の map と同梱 Pi CLI の transcript は wrapper が指定した専用 directory 内に作られるため、新規ファイルにもこの DACL が継承される。既存の repository storage tree 内も再帰的に設定し、読み戻した ACL が owner・ACE 数・identity・権限・継承設定の条件を満たすことを確認する。
- PowerShell / `icacls.exe` が起動できない、ACL を変更できない、または検証に失敗した場合は、upstream adapter を起動せず builtin attach を失敗させる。
- ACL の対象は builtin worker の専用保存先と session map / transcript である。Pi の共有 settings / auth root、BYO の保存先、その他の利用者データは変更しない。upstream 更新時は map / transcript の作成先と permission の振る舞いを確認する。

## Consequences

- Windows でも、通常権限の別 OS account に対して map / transcript へのアクセスを現在の account に限定する。POSIX では引き続き directory `0700`、file `0600`、および wrapper process の `umask 077` を使う。
- 同じ Windows account で動く別 process、管理者、SYSTEM、backup privilege を持つ主体からのアクセスは防がない。NTFS ACL を無視する・別 ACL を重ねる storage、保存先の外へ書く将来の upstream、upstream が ACL を明示的に広げる変更もこの保証の対象外である。
- 既存 storage の ACL を変更できない環境では builtin runtime は fail closed になる。BYO runtime の挙動は変わらない。
