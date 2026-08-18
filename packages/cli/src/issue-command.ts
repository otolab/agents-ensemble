import { resolve } from 'node:path';
import {
  findLatestSessionSidecarForIssue,
  loadProfile,
  resolveConductorModelId,
  runIssueSession,
  SessionLogger,
  type ConductorSessionResult,
} from '@agents-ensemble/core';
import { bindAsyncOperatorInput, notifyOperatorInputReprompt } from './async-operator-input.js';
import { isOperatorInputInteractive, isOperatorInputTty } from './prompt-operator-input.js';
import { parseWorktreeMode } from './parse-worktree-mode.js';
import { resolveCliMaxTurns } from './resolve-cli-max-turns.js';
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
  worktree: string;
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
): number {
  return resolveCliMaxTurns({
    interactive,
    noMaxTurns: options.noMaxTurns,
    maxTurns: options.maxTurns,
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
  const SessionLoggerCtor = deps.SessionLogger ?? SessionLogger;

  const workerWorktreeMode = parseWorktreeMode(options.worktree);
  const { profile, profilePath } = await loadProfileFn({
    profile: options.profile,
    cwd: resolve(options.repoRoot),
  });
  const repoRoot = resolve(options.repoRoot);
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

  const maxTurns = resolveIssueSessionMaxTurns(options, interactive);

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
      modelId: resolveConductorModelId(options.model),
      maxTurns,
      workerWorktreeMode,
      sessionLogger,
      ...(options.githubMonitor === false
        ? { disableGitHubMonitor: true }
        : {}),
      ...(options.githubMonitorDebounceMs !== undefined
        ? { githubMonitorDebounceMs: options.githubMonitorDebounceMs }
        : {}),
      ...(defaultAcp ? { defaultAcp } : {}),
      ...(interactive
        ? {
            bindOperatorInput: tuiHost?.bindOperatorInput ?? bindAsyncOperatorInput,
            continueOnConductorError: true,
            ...(isTty() && !options.noWait
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
