# ADR 0089: Builtin Pi worker の保存 root を session ごとに固定する

- Status: accepted
- Date: 2026-11-28

## Context

Builtin Pi worker の HOME と transcript 保存先は user root 配下に固定されていた一方、Pi conductor の settings / auth は `conductor.pi.agentDir` を使っていた。保存先を同じ実効 Pi root にそろえるには、session map と transcript の読み出し側にも root を伝える必要がある。さらに、設定変更後の resume が別 root の同名 map を読むと ADR 0068 の fail-closed 契約を崩す。

旧 SessionResumeStore には worker HOME がない。旧 builtin session の map は共有 HOME にあり、transcript はその map が指す旧 path に残っている。旧 map の全 entry を新 map に混ぜたり、設定変更時に root を暗黙に切り替えたりすると、別 session の選択や resume の誤接続につながる。operator-agent の `common.pi.agentDir` は operator 自身の Pi resource root であり、worker session の保存場所とは別の設定である。

## Decision

- 新しい builtin Pi worker の HOME は、実効 `conductor.pi.agentDir`（`PI_CODING_AGENT_DIR` を含む）の下に作る。Issue と workspace の既定 user root を使う従来動作は、明示 root がない場合に維持する。
- session の worker HOME を SessionResumeStore に記録し、session generation ごとにも保持する。resume と共通 worker-history reader は保存済み HOME を使う。Pi settings / auth は現在の設定から解決し、`common.pi.agentDir` は worker reader に適用しない。
- worker HOME を記録していない旧 Store は従来の user-root 保存先を使う。既知の旧 map から移行するのは、指定 session ID / cwd、map entry の session ID / cwd、transcript header が一致し、transcript が通常 file として既知の旧 HOME 内にある一 entry に限る。
- 旧 map / transcript は削除も移動もしない。新 map はその一 entry だけを持ち、既存 map と旧 map は merge しない。新 map がある場合は authoritative とし、対象 entry が欠落・不正・不一致なら resume / reader を fail-closed にする。新 map がまだない場合のみ既知の旧 map を参照する。
- transcript は map が指す旧 path のまま使う。copy / move は行わない。
- map の全体更新を行う upstream adapter は worker HOME ごとに lock する。同じ HOME の concurrent attach は安全に直列化できないため後続を拒否する。異なる Issue / workspace の HOME は独立する。
- 保存された絶対 path は local SessionResumeStore の metadata として信頼する。worker identity に対応する末尾 path を検査し、reader は transcript を worker HOME または既知の旧 HOME に閉じ込める。root の移設・改名は自動追跡しない。path が失われた、または map / transcript の identity が確認できない場合は、元 path の復元か明示的な調査が必要になる。

## Consequences

- Pi user resource root を変えても、既存 session の resume と履歴は保存時の worker HOME を使う。新しい session は新 root に作られる。
- 旧 map / transcript は保持される。移行先 map は対象 session 一件のみを持ち、元 transcript path を参照するため、移行後も transcript 自体の複製や削除は発生しない。
- 移行先の map が競合している場合は旧 map で穴埋めしない。map の破損、cwd / ID の不一致、transcript の欠落、同 HOME の lock 競合は fail-closed になる。
- 保存 root を別 directory に移しただけでは自動 resume できない。SessionResumeStore と map が指す transcript はローカルの保存先に依存する。
- 旧 wrapper や外部 process は新しい HOME lock に参加しない。同じ OS user が storage を同時に直接変更する場合や、filesystem の非協調動作までは防げない。
