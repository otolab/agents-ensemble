import type { WorkerWorktreeMode } from '../worktree/worktree.js';
import type { BuiltinAcpPresetId } from '../acp/resolve-acp-spawn.js';

export interface EnsembleProfileConfig {
  /** `--profile` 未指定時の team profile 参照（名前またはパス）。 */
  default?: string;
}

export interface EnsembleConfigControlConfig {
  /** user config で project `.ensemble/config.yaml` の読み込みを無効にする。 */
  loadProjectConfig: boolean;
}

export type ConductorBackend = 'cursor' | 'pi';

/** ACP worker model tiers selected by each team-profile worker entry. */
export type AcpModelTag = 'high' | 'default' | 'low' | 'fast';

export interface EnsembleConductorPiConfig {
  /** Pi の user resource root。絶対パスまたは repoRoot 基準の相対パス。 */
  agentDir?: string;
  /** Pi の project resource root。絶対パスまたは repoRoot 基準の相対パス。 */
  projectDir?: string;
}

export interface EnsembleConductorConfig {
  /** conductor モデル id（`auto` は `default` と同義）。 */
  model: string;
  /** conductor LLM backend（未指定時は `cursor`）。 */
  backend?: ConductorBackend;
  /** harness の詳細 telemetry を人間向け出力へ表示するか。 */
  verbose?: boolean;
  /** Pi resource root のパス上書き（Pi の設定スキーマではない）。 */
  pi?: EnsembleConductorPiConfig;
}

export interface EnsembleAcpConfig {
  /** 全 worker に適用する built-in preset。 */
  defaultPreset: BuiltinAcpPresetId;
  /** codex-acp 等の子プロセス spawn に渡す env（user → project deep merge）。 */
  env?: Record<string, string>;
  /** 環境ごとの ACP model ID catalog。tag mapping から参照する。 */
  models?: Record<string, string>;
  /** profile worker の modelTag から models key への共通 mapping。 */
  tags?: Partial<Record<AcpModelTag, string>>;
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
  /** ACP worker attach を初回 `prompt_worker` まで遅延する。既定は eager。 */
  lazyWorkers: boolean;
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
  config: EnsembleConfigControlConfig;
  profile: EnsembleProfileConfig;
  conductor: EnsembleConductorConfig;
  acp: EnsembleAcpConfig;
  session: EnsembleSessionConfig;
  github: EnsembleGitHubConfig;
  tui: EnsembleTuiConfig;
}

/** YAML 1 層分の parse 結果（deep merge 前）。各セクションは部分指定可。 */
export type EnsembleConfigLayer = {
  [K in keyof EnsembleConfig]?: Partial<EnsembleConfig[K]>;
};
