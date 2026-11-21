import { ANSI_RED } from '../internal/operator-utils.js';
import { createInterface } from 'node:readline';
import { constants as fsConstants } from 'node:fs';
import { lstat, mkdir, open } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { compile, merge } from '@modular-prompt/core';
import {
  createGitHubClient,
  DEFAULT_ENSEMBLE_CONFIG,
} from '@agents-ensemble/core';
import {
  closeConductorAgentOnce,
  createConductorAgentFactory,
  ConductorDispatchLifecycle,
  ConductorRecoveryInbox,
  executeRecoveryInboxCommand,
  escapeTerminalControlCharacters,
  formatConductorAuthRecoveryHint,
  isConductorSendAuthError,
  isOperatorCommand,
  reconnectConductorAgent,
  renderCompiledPrompt,
  resolvePiConductorProvider,
  resolveUserEnsembleRoot,
  settleConductorDispatch,
  sendConductorWithReconnect,
  type ConductorAgent,
  type ConductorAgentCreateOptions,
  type ConductorAgentHandle,
  type ConductorAgentFactory,
  type ConductorBackend,
  type ConductorRecoveryReconnect,
  type ConductorSendResult,
  type SessionResumeStoreDuplicateDiagnostic,
} from '@agents-ensemble/core/operator-runtime';
import { operatorBaseModule } from './operator-base-module.js';
import { OperatorLockTimeoutError, withOperatorWorkspaceLock } from '../workspace/operator-workspace-lock.js';
import {
  createOperatorDispatchQueue,
  formatOperatorDispatchBatch,
  type OperatorDispatchBatch,
  type OperatorDispatchState,
} from '../dispatch/operator-dispatch.js';
import {
  OPERATOR_WATCH_ACK_MAX_RETRIES,
  OPERATOR_WATCH_ACK_RETRY_DELAY_MS,
  retryOperatorWatchAcknowledgement,
} from '../watch/operator-watch-ack.js';
import { createListOperatorSessionsTool } from '../tools/list-operator-sessions-tool.js';
import {
  createReleaseReportsTool,
  createSetReportHoldTool,
  createSetSessionFocusTool,
  createRequestSessionReportsTool,
  createListPendingReportsTool,
} from '../tools/operator-control-tools.js';
import {
  createOperatorWatchPool,
  createRegisterConductorMessageListenTool,
  createRegisterRepositoryWatchTool,
  createRegisterSessionWatchTool,
  createUnregisterConductorMessageListenTool,
  createUnregisterRepositoryWatchTool,
  createUnregisterSessionWatchTool,
  type OperatorWatchPool,
} from '../watch/operator-watch-pool.js';
import {
  createAnswerLiveOpenQuestionTool,
  createGetLastConductorMessageTool,
  createListConductorMessagesTool,
  createListLiveOpenQuestionsTool,
  createSendOperatorMessageTool,
  createShutdownIssueSessionTool,
} from '../tools/open-question-control-tools.js';
import { createListWorkerMessagesTool } from '../tools/worker-session-tools.js';
import {
  createOperatorWorkspaceFileTools,
  assertNoMoveJournal,
  workspaceMoveJournalPath,
  resolveOperatorWorkspaceRoot,
} from '../workspace/operator-workspace-tools.js';
import {
  listOperatorAgentStates,
  loadOperatorAgentState,
  saveOperatorAgentState,
  clearOperatorAgentState,
  operatorPiSessionDirectory,
  type OperatorAgentState,
} from './operator-agent-state.js';
import {
  loadOperatorAgentConfiguration,
  OPERATOR_AGENT_BACKEND_ENV,
  OPERATOR_AGENT_MODEL_ENV,
  OPERATOR_AGENT_PROFILE_ENV,
  OPERATOR_AGENT_REASONING_ENV,
  normalizeRepositoryPattern,
  resolveOperatorPath,
  validateProfileName,
  type OperatorAgentConfiguration,
  type OperatorAgentProfile,
  type OperatorAgentSchedulingConfig,
  resolveOperatorAgentScheduling,
} from '../config/operator-agent-config.js';
import { resolveOperatorAgentMcpServers } from '../config/operator-agent-mcp.js';
import {
  createOperatorAgentTuiHost,
  type OperatorAgentTuiLogOptions,
} from '../tui/operator-agent-tui.js';
import { createOperatorIdleCandidateMonitor } from '../dispatch/operator-idle-candidates.js';

import type { RunOperatorAgentOptions, OperatorAgentInput, OperatorAgentOutput, RunOperatorAgentDependencies, OperatorRuntime, OperatorAgentHandle, OperatorAgentDispatchPayload, OperatorTtyChannels, OperatorPiActivityEvent, OperatorPiActivity, OperatorTtyLogEntry, OperatorTtyLogRouter } from './run-operator-agent-types.js';

export async function resolveOperatorRuntime(
  options: RunOperatorAgentOptions,
  dependencies: RunOperatorAgentDependencies,
  existingState?: OperatorAgentState,
  tty?: {
    stdin: OperatorAgentInput;
    stdout: OperatorAgentOutput;
    log?: (detail: string) => void;
  },
): Promise<OperatorRuntime> {
  const userEnsembleRoot = resolve(
    resolveUserEnsembleRoot({
      ...(dependencies.userEnsembleRoot
        ? { userEnsembleRoot: dependencies.userEnsembleRoot }
        : {}),
    }),
  );
  const config = await loadOperatorAgentConfiguration(userEnsembleRoot);
  const repoFilters = (options.repoFilters ?? []).map((pattern) =>
    normalizeRepositoryPattern(pattern, '--repo-filter'),
  );
  const selectedProfileName = await selectProfileName(
    options,
    config,
    existingState,
    tty,
  );
  const profile = config.profiles[selectedProfileName];
  if (!profile) {
    throw new Error(`Operator-agent profile "${selectedProfileName}" is not defined.`);
  }
  const mcpServers = await resolveOperatorAgentMcpServers(
    userEnsembleRoot,
    selectedProfileName,
    profile,
    config.common,
  );
  const workspace = join(
    userEnsembleRoot,
    'operator-agents',
    selectedProfileName,
  );
  await mkdir(workspace, { recursive: true, mode: 0o700 });
  const backend = resolveOperatorSetting(
    process.env[OPERATOR_AGENT_BACKEND_ENV],
    profile.conductor?.backend,
    config.common.conductor?.backend,
    'pi',
    'backend',
  ) as ConductorBackend;
  const modelId =
    process.env[OPERATOR_AGENT_MODEL_ENV]?.trim() ||
    profile.conductor?.model ||
    config.common.conductor?.model ||
    'default';
  const reasoning =
    process.env[OPERATOR_AGENT_REASONING_ENV]?.trim() ||
    profile.conductor?.reasoning ||
    config.common.conductor?.reasoning;
  const scheduling = resolveOperatorAgentScheduling(
    config.common.scheduling,
    profile.scheduling,
  );
  const agentDir = resolveOperatorPath(
    config.common.pi?.agentDir ??
      process.env.PI_CODING_AGENT_DIR ??
      join(userEnsembleRoot, 'pi'),
    userEnsembleRoot,
  );
  const projectDir = resolveOperatorPath(
    profile.pi?.projectDir ?? join(workspace, 'pi'),
    workspace,
  );
  const piResourceRoots = { agentDir, projectDir };
  const promptModule = profile.prompt?.instructions?.length
    ? merge(operatorBaseModule, {
        instructions: profile.prompt.instructions,
      })
    : operatorBaseModule;
  const canonicalWorkspace = await resolveOperatorWorkspaceRoot(workspace);
  const workspaceInstructions = await withOperatorWorkspaceLock(
    canonicalWorkspace,
    async () => {
      await assertNoMoveJournal(workspaceMoveJournalPath(canonicalWorkspace));
      return loadWorkspaceInstructions(canonicalWorkspace);
    },
  );
  const basePrompt = renderCompiledPrompt(
    compile(
      promptModule,
      {
        workspace,
        backend,
        profileName: selectedProfileName,
      },
    ),
  );

  const systemPrompt = workspaceInstructions
    ? `${basePrompt}\n\n### Profile workspace instructions (AGENTS.md)\n\n${workspaceInstructions}`
    : basePrompt;

  return {
    userEnsembleRoot,
    workspace,
    profileName: selectedProfileName,
    config,
    repoFilters,
    profile,
    backend,
    modelId,
    ...(reasoning !== undefined ? { reasoning } : {}),
    ...(mcpServers ? { mcpServers } : {}),
    piResourceRoots,
    systemPrompt,
    scheduling,
  };
}

export function addOperatorMcpStartupContext(
  factory: ConductorAgentFactory,
): ConductorAgentFactory {
  const withContext = async <T>(
    options: ConductorAgentCreateOptions,
    start: () => Promise<T>,
  ): Promise<T> => {
    try {
      return await start();
    } catch (error) {
      const names = Object.keys(options.mcpServers ?? {});
      if (names.length === 0) throw error;
      const reason = error instanceof Error ? error.message : String(error);
      if (names.some((name) => reason.includes(name))) throw error;
      throw new Error(
        `Operator-agent conductor startup failed with MCP server(s) [${names.join(', ')}]: ${reason}`,
        { cause: error },
      );
    }
  };

  return {
    create: (options) =>
      withContext(options, () => factory.create(options)),
    resume: (agentId, options) =>
      withContext(options, () => factory.resume(agentId, options)),
  };
}

export async function selectSavedConversation(
  states: readonly OperatorAgentState[],
  stdin: OperatorAgentInput,
  stdout: OperatorAgentOutput,
): Promise<OperatorAgentState> {
  const selected = await promptForChoice(
    [
      '再開する operator-agent conversation を選んでください:',
      ...states.map(
        (state, index) =>
          `${index + 1}) ${state.operatorAgentId}  profile=${state.profile}  updated=${new Date(state.updatedAt).toISOString()}`,
      ),
    ].join('\n'),
    states.map((state) => state.operatorAgentId),
    stdin,
    stdout,
  );
  return states.find((state) => state.operatorAgentId === selected)!;
}

async function loadWorkspaceInstructions(workspace: string): Promise<string | undefined> {
  const path = join(workspace, 'AGENTS.md');
  try {
    let metadata;
    try {
      metadata = await lstat(path);
    } catch (error) {
      if (error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT') {
        return undefined;
      }
      throw error;
    }
    if (metadata.isSymbolicLink()) {
      throw new Error('AGENTS.md must not be a symbolic link.');
    }
    const handle = await open(path, fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0));
    try {
      if (!(await handle.stat()).isFile()) {
        throw new Error('AGENTS.md must be a regular file.');
      }
      const bytes = await handle.readFile();
      return new TextDecoder('utf-8', { fatal: true }).decode(bytes).trim() || undefined;
    } finally {
      await handle.close();
    }
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new Error(`Failed to read profile workspace instructions at ${path}: ${detail}`, {
      cause: error,
    });
  }
}

async function selectProfileName(
  options: RunOperatorAgentOptions,
  config: OperatorAgentConfiguration,
  existingState?: OperatorAgentState,
  tty?: {
    stdin: OperatorAgentInput;
    stdout: OperatorAgentOutput;
    log?: (detail: string) => void;
  },
): Promise<string> {
  const commandLineProfile = options.profile?.trim();
  const environmentProfile = process.env[OPERATOR_AGENT_PROFILE_ENV]?.trim();
  const requested = commandLineProfile || environmentProfile;
  if (requested) {
    validateProfileName(requested);
    if (!Object.hasOwn(config.profiles, requested)) {
      throw new Error(`Operator-agent profile "${requested}" is not defined.`);
    }
    return requested;
  }
  if (existingState && Object.hasOwn(config.profiles, existingState.profile)) {
    return existingState.profile;
  }
  if (existingState) {
    const message =
      `保存会話の profile=${existingState.profile} は現在の operator config にありません。利用可能な profile を選びます。`;
    if (tty?.log) {
      tty.log(message);
    } else {
      tty?.stdout.write(`\n[observation] ${message}\n\n`);
    }
  }
  if (config.defaultProfile) return config.defaultProfile;
  const profiles = Object.keys(config.profiles).sort();
  if (profiles.length === 1) return profiles[0]!;
  if (profiles.length === 0) {
    throw new Error(
      'operator-agents.config.yaml に少なくとも1つの profile を定義してください。',
    );
  }
  if (!tty) {
    throw new Error(
      `Profile must be selected with --profile. Available profiles: ${profiles.join(', ')}.`,
    );
  }
  const selected = await promptForChoice(
    [
      'operator-agent profile を選んでください:',
      ...profiles.map((profile, index) => `${index + 1}) ${profile}`),
    ].join('\n'),
    profiles,
    tty.stdin,
    tty.stdout,
  );
  return selected;
}

async function promptForChoice(
  prompt: string,
  choices: readonly string[],
  stdin: OperatorAgentInput,
  stdout: OperatorAgentOutput,
): Promise<string> {
  stdout.write(`${prompt}\n> `);
  const terminal = createInterface({
    input: stdin,
    output: stdout,
    terminal: true,
    crlfDelay: Infinity,
  });
  return new Promise<string>((resolveChoice, rejectChoice) => {
    terminal.question('', (answer) => {
      terminal.close();
      const normalized = answer.trim();
      const byIndex = Number(normalized);
      if (Number.isInteger(byIndex) && byIndex >= 1 && byIndex <= choices.length) {
        resolveChoice(choices[byIndex - 1]!);
        return;
      }
      if (choices.includes(normalized)) {
        resolveChoice(normalized);
        return;
      }
      rejectChoice(
        new Error(
          `Invalid selection "${normalized}". Enter a number from 1 to ${choices.length} or an exact ID.`,
        ),
      );
    });
  });
}

function resolveOperatorSetting(
  environmentValue: string | undefined,
  profileValue: string | undefined,
  commonValue: string | undefined,
  fallback: string,
  name: 'backend',
): string {
  const selected =
    environmentValue?.trim() || profileValue || commonValue || fallback;
  if (name === 'backend' && selected !== 'pi' && selected !== 'cursor') {
    throw new Error(
      `${OPERATOR_AGENT_BACKEND_ENV} must be "pi" or "cursor" (received "${selected}").`,
    );
  }
  return selected;
}
