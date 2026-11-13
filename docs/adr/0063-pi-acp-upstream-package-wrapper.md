# ADR 0063: Pi ACP upstream npm dependency と core wrapper

- Status: superseded in part by [ADR 0065](0065-pi-acp-version-split-for-byo-compatibility.md) (dependency version assignment only)
- Date: 2026-11-12
- Supersedes: [ADR 0062](0062-builtin-pi-acp-runtime.md)
- Related: [Issue #670](https://github.com/otolab/agents-ensemble/issues/670)

## Context

ADR 0062 は `svkozak/pi-acp` を vendor した独立 package を公開する判断だった。operator は upstream adapter の source を保守する負担を避け、upstream npm package と Ensemble 設定を渡す薄い wrapper で製品要件を満たすよう方針を変更した。

公開済み upstream の `pi-acp@0.0.34` は `pi-acp` bin、`PI_ACP_PI_COMMAND`、model / thinkingLevel の ACP 設定を提供する。一方、session map は `$HOME/.pi/pi-acp/session-map.json` 固定で、session discovery は Pi `settings.json` の `sessionDir` を参照し、`PI_CODING_AGENT_SESSION_DIR` を直接参照しない。

## Decision

- 取り込み方式: upstream `pi-acp@0.0.34` を core の exact-version dependency とし、core 内 wrapper で builtin の設定・保存先を渡す。第一方 adapter package は公開しない。

BYO runtime は既定のまま維持する。BYO は upstream adapter を bundled dependency 優先で解決し、Pi CLI は従来どおり PATH から起動する。Pi の `HOME`、設定、認証、session map、transcript 保存先は変更しない。runtime marker のない既存 fingerprint は引き続き BYO と解釈する。

builtin runtime では wrapper process の `HOME` / `USERPROFILE` を repo・worker ごとの `~/.ensemble/pi/worker/<repoKey>/<workerKey>/` に向ける。これにより upstream 固定の `$HOME/.pi/pi-acp/session-map.json` を worker 単位に隔離する。Pi transcript は `PI_CODING_AGENT_SESSION_DIR`、Pi settings / credential は解決済みの `conductor.pi.agentDir` を `PI_CODING_AGENT_DIR` で指定する。初回のみ builtin の既定 settings を `settings.json` に用意し、既存設定は上書きしない。旧 builtin map は wrapper 起動時に新 path へコピーし、CLI reader は移行前の map も fallback で読む。

上流更新は `pi-acp` の release を確認したうえで exact-version dependency と lockfile を手動更新する。一般化できる不具合・機能は upstream に PR を提案する。core wrapper は Ensemble 固有の設定・環境・保存先の配線に留め、upstream source の vendor や downstream fork は通常運用にしない。必要な振る舞いを wrapper で実現できず、upstream でも提供されない場合は、別の取り込み方式へ切り替える前に論点と選択肢を Issue に記録して operator 判断を求める。

## Consequences

- Upstream の model / thinking、ACP protocol、session map 実装は npm dependency の更新で取り込める。
- Builtin の session map と transcript は repo / worker ごとに分離し、Pi settings / credential は `conductor.pi.agentDir` と共有する。BYO の既定経路と既存 map の読み取りは保つ。Adapter の解決先変更で記録される実行 command は変わりうるが、built-in preset の resume 判定は preset と runtime marker を照合する。
- Upstream `session/list` の discovery は `PI_CODING_AGENT_SESSION_DIR` を見ず、共有 `agentDir/settings.json` の `sessionDir` または既定 `agentDir/sessions` を使う。通常の map-backed `session/load` と Ensemble history reader は独立しているが、map を失った場合の upstream discovery は builtin worker の transcript を見つけられないことがある。
- Adapter の上流追従は exact-version dependency と lockfile の手動更新で行う。wrapper に上流 source をコピーせず、上流にない必須機能が見つかった場合は Issue で方針判断を行う。
