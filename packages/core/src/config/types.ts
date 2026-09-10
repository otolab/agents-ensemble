import type { WorkerWorktreeMode } from '../worktree/worktree.js';
import type { BuiltinAcpPresetId } from '../acp/resolve-acp-spawn.js';

export interface EnsembleProfileConfig {
  /** `--profile` 未指定時の team profile 参照（名前またはパス）。 */
  default?: string;
}

export interface EnsembleConductorConfig {
  /** conductor モデル id（`auto` は `default` と同義）。 */
  model: string;
}

export interface EnsembleAcpConfig {
  /** profile / worker に ACP 未指定時の built-in preset。 */
  defaultPreset: BuiltinAcpPresetId;
}

export interface EnsembleSessionMaxTurnsConfig {
  /** TTY 時の max-turns（0 = 無制限）。 */
  tty: number;
  /** 非 TTY 時の max-turns（0 = 無制限）。 */
  nonTty: number;
}

export interface EnsembleSessionPostLoopConfig {
  /** 自律ループ停止後にオペレータ入力を待つか（TTY 時のみ有効）。 */
  wait: boolean;
}

export interface EnsembleSessionConfig {
  worktree: WorkerWorktreeMode;
  maxTurns: EnsembleSessionMaxTurnsConfig;
  postLoop: EnsembleSessionPostLoopConfig;
}

export interface EnsembleGitHubAuthConfig {
  /** GITHUB_TOKEN / GH_TOKEN が無いとき `gh auth token` を試すか（既定: true）。 */
  allowGhAuthTokenFallback: boolean;
}

export interface EnsembleGitHubMonitorConfig {
  enabled: boolean;
  debounceMs: number;
  pollIntervalMs: number;
  activePollIntervalMs: number;
  stopPollWaitMs: number;
}

export interface EnsembleGitHubConfig {
  auth: EnsembleGitHubAuthConfig;
  monitor: EnsembleGitHubMonitorConfig;
}

/** TTY レイアウト（`pane` = 4 ペイン windowing、`stream` = Static + scrollback）。 */
export type TuiLayoutMode = 'pane' | 'stream';

/** OSC 8 ハイパーリンク判定の上書き（`auto` = 端末自動判定）。 */
export type TuiForceHyperlinkMode = 'auto' | 'on' | 'off';

export interface EnsembleTuiConfig {
  /** TTY レイアウト（非 TTY では `pane` にフォールバック）。 */
  layout: TuiLayoutMode;
  /** Issue リンクの OSC 8 強制 on/off / 自動。 */
  forceHyperlink: TuiForceHyperlinkMode;
}

export interface EnsembleConfig {
  profile: EnsembleProfileConfig;
  conductor: EnsembleConductorConfig;
  acp: EnsembleAcpConfig;
  session: EnsembleSessionConfig;
  github: EnsembleGitHubConfig;
  tui: EnsembleTuiConfig;
}
