import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import {
  findLatestSessionResumeStoreForWorkspace,
  loadEnsembleConfig,
  loadProfile,
  resolveConductorModelId,
  resolveConductorReasoning,
  resolveConductorVerboseSetting,
  resolveSessionMaxTurns,
  resolveSessionPostLoopWait,
  runConductorSession,
  SessionLogger,
  workspaceSessionUrl,
  resolveWorkspaceSlugKey,
  type ConductorSessionResult,
  type EnsembleConfig,
  listWorkspaceSlugEntries,
  acquireSessionMigrationReadLock,
} from '@agents-ensemble/core';
import { bindAsyncOperatorInput, notifyOperatorInputReprompt } from './async-operator-input.js';
import {
  isOperatorInputInteractive,
  isOperatorInputTty,
  isOperatorRecoveryInspectionTty,
} from './prompt-operator-input.js';
import { createSessionDisplaySink } from './display/create-session-display-sink.js';
import { selectSessionDisplayBackend } from './display/select-session-display-backend.js';
import { createHarnessSink, createObservationSink } from './session-sinks.js';
import { createIssueSessionTuiHost } from './tui/create-issue-session-tui-host.js';
import { readCliPackageVersion } from './cli-version.js';
import {
  normalizeInitialOperatorMessage,
  resolveInitialOperatorMessage,
} from './operator-message.js';
export interface ResolveResumeAgentIdResult {
  resumeAgentId?: string;
  continuedFromResumeStore?: string;
}

export interface RunCommandOptions {
  repoRoot: string;
  conductorCwd: string;
  briefPath?: string;
  resume?: string;
  continue?: boolean;
  configPath?: string;
  profile?: string;
  model?: string;
  reasoning?: string;
  verbose?: boolean;
  maxTurns?: number;
  noMaxTurns?: boolean;
  noWait?: boolean;
  name?: string;
  defaultAcpCli?: string;
  defaultAcpCommand?: string;
  defaultAcpArgs?: string[];
  secretCliEntrypoint?: string;
  initialOperatorMessage?: string;
  permissionDeadlockStallMs?: number;
  dispatchHoldReminderMs?: number;
}

export interface RunCommandDeps {
  isOperatorInputInteractive?: typeof isOperatorInputInteractive;
  isOperatorInputTty?: typeof isOperatorInputTty;
  isOperatorRecoveryInspectionTty?: typeof isOperatorRecoveryInspectionTty;
  runConductorSession?: typeof runConductorSession;
  loadProfile?: typeof loadProfile;
  loadEnsembleConfig?: typeof loadEnsembleConfig;
  SessionLogger?: typeof SessionLogger;
  findLatestSessionResumeStoreForWorkspace?: typeof findLatestSessionResumeStoreForWorkspace;
  resolveWorkspaceSlugKey?: typeof resolveWorkspaceSlugKey;
  readBriefFile?: typeof readBriefFile;
  writeStderr?: (message: string) => void;
}

export function runCommandExitCode(
  result: Pick<ConductorSessionResult, 'stopReason'>,
): number {
  return result.stopReason === 'error' ? 2 : 0;
}

export function resolveRunSessionMaxTurns(
  options: Pick<RunCommandOptions, 'maxTurns' | 'noMaxTurns'>,
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

export async function readBriefFile(briefPath: string): Promise<string> {
  const resolved = resolve(briefPath);
  const text = await readFile(resolved, 'utf8');
  if (!text.trim()) {
    throw new Error(`Brief file is empty: ${resolved}`);
  }
  return text;
}

export async function resolveRunResumeAgentId(
  options: Pick<RunCommandOptions, 'resume' | 'continue'>,
  context: { slugKey: string; repoRoot: string },
  deps: Pick<RunCommandDeps, 'findLatestSessionResumeStoreForWorkspace'> = {},
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
    deps.findLatestSessionResumeStoreForWorkspace ??
    findLatestSessionResumeStoreForWorkspace;
  const resumeStore = await findLatest({
    repoRoot: context.repoRoot,
    slugKey: context.slugKey,
  });
  if (!resumeStore) {
    throw new Error(
      `No saved session resume store found for workspace slug ${context.slugKey}. Start a new session without --continue.`,
    );
  }
  return {
    resumeAgentId: resumeStore.conductorAgentId,
    continuedFromResumeStore: resumeStore.conductorAgentId,
  };
}

export async function executeRunCommand(
  options: RunCommandOptions,
  deps: RunCommandDeps = {},
): Promise<ConductorSessionResult> {
  const release = await acquireSessionMigrationReadLock();
  try {
    return await executeRunCommandWithGate(options, deps);
  } finally {
    release();
  }
}

async function executeRunCommandWithGate(
  options: RunCommandOptions,
  deps: RunCommandDeps,
): Promise<ConductorSessionResult> {
  const isInteractive =
    deps.isOperatorInputInteractive ?? isOperatorInputInteractive;
  const isTty = deps.isOperatorInputTty ?? isOperatorInputTty;
  const canInspectRecovery =
    deps.isOperatorRecoveryInspectionTty ?? isOperatorRecoveryInspectionTty;
  const runSession = deps.runConductorSession ?? runConductorSession;
  const loadProfileFn = deps.loadProfile ?? loadProfile;
  const loadConfig = deps.loadEnsembleConfig ?? loadEnsembleConfig;
  const SessionLoggerCtor = deps.SessionLogger ?? SessionLogger;
  const resolveSlug =
    deps.resolveWorkspaceSlugKey ?? resolveWorkspaceSlugKey;
  const readBrief = deps.readBriefFile ?? readBriefFile;
  const writeStderr =
    deps.writeStderr ?? ((message: string) => void process.stderr.write(`${message}\n`));

  const repoRoot = resolve(options.repoRoot);
  const conductorCwd = resolve(options.conductorCwd);
  const slugKey = await resolveSlug({
    cwd: conductorCwd,
    ...(options.name !== undefined ? { explicitName: options.name } : {}),
  });
  const issueUrl = workspaceSessionUrl(slugKey);

  const initialOperatorMessage = normalizeInitialOperatorMessage(
    options.initialOperatorMessage,
  );
  const resolvedInitialOperatorMessage = resolveInitialOperatorMessage(
    initialOperatorMessage,
  );

  const ensembleConfig = await loadConfig(repoRoot, {
    ...(options.configPath !== undefined ? { configPath: options.configPath } : {}),
  });
  const conductorReasoning = resolveConductorReasoning(options.reasoning, {
    config: ensembleConfig,
  });
  const conductorVerbose = resolveConductorVerboseSetting({
    cliVerbose: options.verbose,
    config: ensembleConfig,
  });
  const { profile, profilePath } = await loadProfileFn({
    profile: options.profile,
    cwd: repoRoot,
    config: ensembleConfig,
  });
  const { resumeAgentId, continuedFromResumeStore } =
    await resolveRunResumeAgentId(options, { slugKey, repoRoot }, deps);
  const briefText = options.briefPath
    ? await readBrief(options.briefPath)
    : undefined;
  if (!briefText && !resumeAgentId) {
    throw new Error(
      'Brief file path is required when starting a new workspace session.',
    );
  }
  if (initialOperatorMessage && resumeAgentId) {
    writeStderr(
      'Warning: the initial CLI operator message is ignored with --continue or --resume.',
    );
  }
  const initialOperatorMessageForBinding = resumeAgentId
    ? undefined
    : initialOperatorMessage;
  const resolvedInitialOperatorMessageForBinding = resumeAgentId
    ? resolveInitialOperatorMessage()
    : resolvedInitialOperatorMessage;
  const interactive = isInteractive(initialOperatorMessageForBinding);
  const hasOneShotOperatorMessage = Boolean(resolvedInitialOperatorMessageForBinding);
  const tty = isTty();
  const operatorCanInspectRecovery = canInspectRecovery();
  const useTui = interactive && tty;
  const tuiHost = useTui
    ? createIssueSessionTuiHost(issueUrl, {
        config: ensembleConfig,
        initialOperatorMessage: initialOperatorMessageForBinding,
        verbose: conductorVerbose,
      })
    : undefined;
  const sessionLogger = new SessionLoggerCtor({ issueUrl, repoRoot });
  if (useTui) {
    sessionLogger.subscribe(tuiHost!.telemetrySink);
  } else {
    sessionLogger.subscribe(
      createHarnessSink({ verbose: conductorVerbose, writeStderr }),
    );
    sessionLogger.subscribe(createObservationSink({ writeStderr }));
  }
  sessionLogger.subscribe(
    createSessionDisplaySink({
      backend:
        tuiHost?.displayBackend ??
        selectSessionDisplayBackend({ interactive: interactive && !useTui }),
      onOpenQuestionEnqueued: tuiHost?.notifyReprompt ?? notifyOperatorInputReprompt,
    }),
  );

  sessionLogger.emit({ type: 'session.worktree.notice', mode: 'in_repo' });
  if (continuedFromResumeStore) {
    sessionLogger.emit({
      type: 'session.continue',
      conductorAgentId: continuedFromResumeStore,
    });
  }

  const maxTurns = resolveRunSessionMaxTurns(options, interactive, ensembleConfig);
  const postLoopWait = resolveSessionPostLoopWait({
    cliNoWait: options.noWait,
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
      conductorCwd,
      briefText,
      cliPackageVersion: readCliPackageVersion(),
      resumeAgentId,
      ensembleConfig,
      profile,
      profilePath,
      modelId: resolveConductorModelId(options.model, { config: ensembleConfig }),
      ...(conductorReasoning !== undefined
        ? { reasoning: conductorReasoning }
        : {}),
      maxTurns,
      workerWorktreeMode: 'in_repo',
      sessionLogger,
      disableGitHubMonitor: true,
      ...(options.permissionDeadlockStallMs !== undefined
        ? { permissionDeadlockStallMs: options.permissionDeadlockStallMs }
        : {}),
      ...(options.dispatchHoldReminderMs !== undefined
        ? { dispatchHoldReminderMs: options.dispatchHoldReminderMs }
        : {}),
      ...(defaultAcp ? { defaultAcp: { ...defaultAcp, config: ensembleConfig } } : { defaultAcp: { config: ensembleConfig } }),
      ...(options.secretCliEntrypoint
        ? { secretCliEntrypoint: options.secretCliEntrypoint }
        : {}),
      ...(interactive
        ? {
            bindOperatorInput:
              tuiHost?.bindOperatorInput ??
              ((api) =>
                bindAsyncOperatorInput(api, {
                  issueUrl,
                  initialOperatorMessage: initialOperatorMessageForBinding,
                })),
            continueOnConductorError: tty || !hasOneShotOperatorMessage,
            ...(!tty && hasOneShotOperatorMessage
              ? { stopOnUnansweredInput: true }
              : {}),
            ...(tty && postLoopWait
              ? { waitForOperatorExit: true }
              : {}),
            operatorCanInspectRecovery,
          }
        : {}),
    });
  } finally {
    tuiHost?.dispose();
  }
}

export interface WorkspaceListResult {
  workspaces: Array<{
    slugKey: string;
    latestUpdatedAt?: number;
    latestConductorAgentId?: string;
  }>;
}

export async function listRunWorkspaces(repoRoot: string): Promise<WorkspaceListResult> {
  const entries = await listWorkspaceSlugEntries({ repoRoot: resolve(repoRoot) });
  return { workspaces: entries };
}

export function formatRunWorkspaceListText(result: WorkspaceListResult): string {
  if (result.workspaces.length === 0) {
    return 'No workspaces found.';
  }
  return result.workspaces
    .map((entry) => {
      const updated =
        entry.latestUpdatedAt !== undefined
          ? new Date(entry.latestUpdatedAt).toISOString()
          : '—';
      const agent = entry.latestConductorAgentId ?? '—';
      return `${entry.slugKey}\t${updated}\t${agent}`;
    })
    .join('\n');
}
