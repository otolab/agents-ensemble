import { resolve } from 'node:path';
import {
  findLatestSessionSidecarForIssue,
  loadEnsembleConfig,
  loadProfile,
  resolveConductorModelId,
  resolveGitHubMonitorDebounceMs,
  resolveGitHubMonitorEnabled,
  resolveSessionMaxTurns,
  resolveSessionPostLoopWait,
  resolveSessionWorktreeMode,
  runIssueSession,
  SessionLogger,
  type ConductorSessionResult,
  type EnsembleConfig,
} from '@agents-ensemble/core';
import { bindAsyncOperatorInput, notifyOperatorInputReprompt } from './async-operator-input.js';
import { isOperatorInputInteractive, isOperatorInputTty } from './prompt-operator-input.js';
import { parseWorktreeMode } from './parse-worktree-mode.js';
import { createSessionDisplaySink } from './display/create-session-display-sink.js';
import { selectSessionDisplayBackend } from './display/select-session-display-backend.js';
import { createHarnessSink, createObservationSink } from './session-sinks.js';
import { createIssueSessionTuiHost } from './tui/create-issue-session-tui-host.js';

export interface IssueCommandOptions {
  repoRoot: string;
  conductorCwd: string;
  resume?: string;
  continue?: boolean;
  profile?: string;
  model?: string;
  maxTurns?: number;
  noMaxTurns?: boolean;
  noWait?: boolean;
  worktree?: string;
  defaultAcpCli?: string;
  defaultAcpCommand?: string;
  defaultAcpArgs?: string[];
  /** commander の `--no-github-monitor` 用。false で監視無効。 */
  githubMonitor?: boolean;
  githubMonitorDebounceMs?: number;
}

export interface IssueCommandDeps {
  isOperatorInputInteractive?: typeof isOperatorInputInteractive;
  isOperatorInputTty?: typeof isOperatorInputTty;
  runIssueSession?: typeof runIssueSession;
  loadProfile?: typeof loadProfile;
  loadEnsembleConfig?: typeof loadEnsembleConfig;
  SessionLogger?: typeof SessionLogger;
  findLatestSessionSidecarForIssue?: typeof findLatestSessionSidecarForIssue;
}

export interface ResolveResumeAgentIdResult {
  resumeAgentId?: string;
  continuedFromSidecar?: string;
}

/** `--resume` / `--continue` から `runIssueSession` に渡す `resumeAgentId` を解決する。 */
export async function resolveResumeAgentIdFromOptions(
  options: Pick<IssueCommandOptions, 'resume' | 'continue'>,
  context: { issueUrl: string; repoRoot: string },
  deps: Pick<IssueCommandDeps, 'findLatestSessionSidecarForIssue'> = {},
): Promise<ResolveResumeAgentIdResult> {
  if (options.resume && options.continue) {
    throw new Error('Cannot use --continue and --resume together');
  }
  if (options.resume) {
    return { resumeAgentId: options.resume };
  }
  if (!options.continue) {
    return {};
  }

  const findLatest =
    deps.findLatestSessionSidecarForIssue ?? findLatestSessionSidecarForIssue;
  const sidecar = await findLatest({
    repoRoot: context.repoRoot,
    issueUrl: context.issueUrl,
  });
  if (!sidecar) {
    throw new Error(
      `No session sidecar found for issue ${context.issueUrl}. Start a new session without --continue.`,
    );
  }

  return {
    resumeAgentId: sidecar.conductorAgentId,
    continuedFromSidecar: sidecar.conductorAgentId,
  };
}

/** `ensemble issue` の CLI オプションから `runIssueSession` に渡す `maxTurns` を決定する。 */
export function resolveIssueSessionMaxTurns(
  options: Pick<IssueCommandOptions, 'maxTurns' | 'noMaxTurns'>,
  interactive: boolean,
  config?: EnsembleConfig,
): number {
  return resolveSessionMaxTurns({
    interactive,
    cliNoMaxTurns: options.noMaxTurns,
    cliMaxTurns: options.maxTurns,
    config,
  });
}

export async function executeIssueCommand(
  issueUrl: string,
  options: IssueCommandOptions,
  deps: IssueCommandDeps = {},
): Promise<ConductorSessionResult> {
  const isInteractive =
    deps.isOperatorInputInteractive ?? isOperatorInputInteractive;
  const isTty = deps.isOperatorInputTty ?? isOperatorInputTty;
  const runSession = deps.runIssueSession ?? runIssueSession;
  const loadProfileFn = deps.loadProfile ?? loadProfile;
  const loadConfig = deps.loadEnsembleConfig ?? loadEnsembleConfig;
  const SessionLoggerCtor = deps.SessionLogger ?? SessionLogger;

  const repoRoot = resolve(options.repoRoot);
  const ensembleConfig = await loadConfig(repoRoot);
  const workerWorktreeMode = parseWorktreeMode(
    resolveSessionWorktreeMode({
      cliWorktree: options.worktree,
      config: ensembleConfig,
    }),
  );
  const { profile, profilePath } = await loadProfileFn({
    profile: options.profile,
    cwd: repoRoot,
    config: ensembleConfig,
  });
  const { resumeAgentId, continuedFromSidecar } = await resolveResumeAgentIdFromOptions(
    options,
    { issueUrl, repoRoot },
    deps,
  );
  const interactive = isInteractive();
  const useTui = interactive && isTty();
  const tuiHost = useTui ? createIssueSessionTuiHost() : undefined;
  const sessionLogger = new SessionLoggerCtor({ issueUrl, repoRoot });
  if (useTui) {
    sessionLogger.subscribe(tuiHost!.telemetrySink);
  } else {
    sessionLogger.subscribe(createHarnessSink());
    sessionLogger.subscribe(createObservationSink());
  }
  sessionLogger.subscribe(
    createSessionDisplaySink({
      backend:
        tuiHost?.displayBackend ??
        selectSessionDisplayBackend({ interactive: interactive && !useTui }),
      onOpenQuestionEnqueued: tuiHost?.notifyReprompt ?? notifyOperatorInputReprompt,
    }),
  );

  if (workerWorktreeMode === 'in_repo') {
    sessionLogger.emit({ type: 'session.worktree.notice', mode: workerWorktreeMode });
  }
  if (continuedFromSidecar) {
    sessionLogger.emit({
      type: 'session.continue',
      conductorAgentId: continuedFromSidecar,
    });
  }

  const maxTurns = resolveIssueSessionMaxTurns(options, interactive, ensembleConfig);
  const postLoopWait = resolveSessionPostLoopWait({
    cliNoWait: options.noWait,
    config: ensembleConfig,
  });
  const githubMonitorEnabled = resolveGitHubMonitorEnabled({
    cliDisabled: options.githubMonitor === false,
    config: ensembleConfig,
  });
  const githubMonitorDebounceMs = resolveGitHubMonitorDebounceMs({
    cliDebounceMs: options.githubMonitorDebounceMs,
    config: ensembleConfig,
  });

  const defaultAcp =
    options.defaultAcpCli ||
    options.defaultAcpCommand ||
    (options.defaultAcpArgs && options.defaultAcpArgs.length > 0)
      ? {
          ...(options.defaultAcpCli ? { defaultAcpCli: options.defaultAcpCli } : {}),
          ...(options.defaultAcpCommand
            ? { defaultAcpCommand: options.defaultAcpCommand }
            : {}),
          ...(options.defaultAcpArgs && options.defaultAcpArgs.length > 0
            ? { defaultAcpArgs: options.defaultAcpArgs }
            : {}),
        }
      : undefined;

  try {
    return await runSession({
      issueUrl,
      repoRoot,
      conductorCwd: resolve(options.conductorCwd),
      resumeAgentId,
      profile,
      profilePath,
      modelId: resolveConductorModelId(options.model, { config: ensembleConfig }),
      maxTurns,
      workerWorktreeMode,
      sessionLogger,
      ...(githubMonitorEnabled ? {} : { disableGitHubMonitor: true }),
      githubMonitorDebounceMs,
      ...(defaultAcp ? { defaultAcp: { ...defaultAcp, config: ensembleConfig } } : { defaultAcp: { config: ensembleConfig } }),
      ...(interactive
        ? {
            bindOperatorInput: tuiHost?.bindOperatorInput ?? bindAsyncOperatorInput,
            continueOnConductorError: true,
            ...(isTty() && postLoopWait
              ? {
                  waitForOperatorExit: true,
                }
              : {}),
          }
        : {}),
    });
  } finally {
    tuiHost?.dispose();
  }
}
