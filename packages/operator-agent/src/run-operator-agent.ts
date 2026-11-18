import { createInterface } from 'node:readline';
import { mkdir } from 'node:fs/promises';
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
import {
  createOperatorDispatchQueue,
  formatOperatorDispatchBatch,
  type OperatorDispatchBatch,
  type OperatorDispatchState,
} from './operator-dispatch.js';
import {
  OPERATOR_WATCH_ACK_MAX_RETRIES,
  OPERATOR_WATCH_ACK_RETRY_DELAY_MS,
  retryOperatorWatchAcknowledgement,
} from './operator-watch-ack.js';
import { createListOperatorSessionsTool } from './list-operator-sessions-tool.js';
import {
  createReleaseReportsTool,
  createSetReportHoldTool,
  createSetSessionFocusTool,
} from './operator-control-tools.js';
import {
  createOperatorWatchPool,
  createRegisterConductorMessageListenTool,
  createRegisterRepositoryWatchTool,
  createRegisterSessionWatchTool,
  createUnregisterConductorMessageListenTool,
  createUnregisterRepositoryWatchTool,
  createUnregisterSessionWatchTool,
  type OperatorWatchPool,
} from './operator-watch-pool.js';
import {
  createAnswerLiveOpenQuestionTool,
  createGetLastConductorMessageTool,
  createListConductorMessagesTool,
  createListLiveOpenQuestionsTool,
  createSendOperatorMessageTool,
  createShutdownIssueSessionTool,
} from './open-question-control-tools.js';
import { createListWorkerMessagesTool } from './worker-session-tools.js';
import {
  createOperatorWorkspaceFileTools,
  resolveOperatorWorkspaceRoot,
} from './operator-workspace-tools.js';
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
} from './operator-agent-config.js';
import { resolveOperatorAgentMcpServers } from './operator-agent-mcp.js';
import {
  createOperatorAgentTuiHost,
  type OperatorAgentTuiLogOptions,
} from './operator-agent-tui.js';
import { createOperatorIdleCandidateMonitor } from './operator-idle-candidates.js';

export interface RunOperatorAgentOptions {
  profile?: string;
  repoFilters?: string[];
  resumeId?: string;
  /** @deprecated Use resumeId. */
  resume?: string;
  newSession?: boolean;
}

export interface OperatorAgentInput extends NodeJS.ReadableStream {
  isTTY?: boolean;
  isRaw?: boolean;
  setRawMode?: (mode: boolean) => unknown;
}

export interface OperatorAgentOutput extends NodeJS.WritableStream {
  isTTY?: boolean;
  columns?: number;
  rows?: number;
}

export interface RunOperatorAgentDependencies {
  stdin?: OperatorAgentInput;
  stdout?: OperatorAgentOutput;
  stderr?: OperatorAgentOutput;
  userEnsembleRoot?: string;
  agentFactory?: ConductorAgentFactory;
}

interface OperatorRuntime {
  userEnsembleRoot: string;
  workspace: string;
  profileName: string;
  profile: OperatorAgentProfile;
  config: OperatorAgentConfiguration;
  repoFilters: string[];
  backend: ConductorBackend;
  modelId: string;
  reasoning?: string;
  mcpServers?: ConductorAgentCreateOptions['mcpServers'];
  piResourceRoots: { agentDir: string; projectDir: string };
  systemPrompt: string;
  scheduling: Required<OperatorAgentSchedulingConfig>;
}

interface OperatorAgentHandle extends ConductorAgentHandle {
  factory: ConductorAgentFactory;
  agentOptions: ConductorAgentCreateOptions;
}

interface OperatorAgentDispatchPayload {
  batch: OperatorDispatchBatch;
}

interface OperatorTtyChannels {
  harness(detail: string, options?: { color?: string }): void;
  observation(detail: string, options?: { color?: string }): void;
}

interface OperatorTtyLogEntry {
  channel: 'harness' | 'observation';
  detail: string;
  options?: OperatorAgentTuiLogOptions;
}

interface OperatorTtyLogRouter {
  append: (
    channel: OperatorTtyLogEntry['channel'],
    detail: string,
    options?: OperatorAgentTuiLogOptions,
  ) => void;
  attach: (sink: (entry: OperatorTtyLogEntry) => void) => () => void;
  drain: () => OperatorTtyLogEntry[];
}

const ANSI_RED = '\u001b[31m';

/** Start an operator-role conversation on an interactive terminal. */
export async function runOperatorAgent(
  options: RunOperatorAgentOptions = {},
  dependencies: RunOperatorAgentDependencies = {},
): Promise<void> {
  const stdin = dependencies.stdin ?? process.stdin;
  const stdout = dependencies.stdout ?? process.stdout;
  const stderr = dependencies.stderr ?? process.stderr;
  assertTty(stdin, stdout);

  const ttyLogRouter = createOperatorTtyLogRouter();
  const ttyChannels: OperatorTtyChannels = {
    harness: (detail, logOptions) =>
      ttyLogRouter.append('harness', detail, logOptions),
    observation: (detail, logOptions) =>
      ttyLogRouter.append('observation', detail, logOptions),
  };
  const userEnsembleRoot = resolve(
    resolveUserEnsembleRoot({
      ...(dependencies.userEnsembleRoot
        ? { userEnsembleRoot: dependencies.userEnsembleRoot }
        : {}),
    }),
  );
  if ((options.resumeId ?? options.resume) && options.newSession) {
    throw new Error('--resume and --new cannot be used together.');
  }
  const savedStates = await listOperatorAgentStates(userEnsembleRoot);
  const requestedResumeId = options.resumeId ?? options.resume;
  let existingState: OperatorAgentState | undefined;
  if (requestedResumeId) {
    existingState = await loadOperatorAgentState(
      userEnsembleRoot,
      requestedResumeId,
    );
    if (!existingState) {
      throw new Error(`No operator-agent conversation found for ${requestedResumeId}.`);
    }
  } else if (!options.newSession) {
    if (savedStates.length === 1) existingState = savedStates[0];
    else if (savedStates.length > 1) {
      existingState = await selectSavedConversation(
        savedStates,
        stdin,
        stdout,
      );
    }
  }
  const runtime = await resolveOperatorRuntime(
    options,
    dependencies,
    existingState,
    {
      stdin,
      stdout,
      log: (detail) => ttyLogRouter.append('observation', detail),
    },
  );
  const workspaceFileTools = createOperatorWorkspaceFileTools(
    await resolveOperatorWorkspaceRoot(runtime.workspace),
  );
  const factory = addOperatorMcpStartupContext(
    dependencies.agentFactory ?? createConductorAgentFactory(runtime.backend),
  );
  const dispatchQueue = createOperatorDispatchQueue({
    batchMaxWaitMs: runtime.scheduling.batchMaxWaitMs,
    idleAgingMs: runtime.scheduling.idleAgingMs,
    focusInactivityTimeoutMs: runtime.scheduling.focusInactivityTimeoutMs,
  });
  const reportResumeStoreDuplicate = (
    diagnostic: SessionResumeStoreDuplicateDiagnostic,
  ) => {
    const candidates = diagnostic.candidates
      .map(
        (candidate) =>
          `${candidate.location}=${candidate.path} (harnessSocketPath=${candidate.hasHarnessSocketPath ? 'present' : 'absent'})`,
      )
      .join('; ');
    const selected = diagnostic.candidates.find(
      (candidate) => candidate.path === diagnostic.selectedPath,
    );
    ttyChannels.harness(
      `duplicate SessionResumeStore for ${diagnostic.conductorAgentId}; ` +
        `selected ${diagnostic.selectedLocation}=${diagnostic.selectedPath} ` +
        `(harnessSocketPath=${selected?.hasHarnessSocketPath ? 'present' : 'absent'}); ` +
        `candidates: ${candidates}`,
    );
  };
  if (existingState && existingState.profile !== runtime.profileName) {
    ttyChannels.observation(
      `保存会話の profile=${existingState.profile} と今回の profile=${runtime.profileName} が異なります。今回の profile 設定で再開を試みます。`,
    );
  }
  if (existingState && existingState.workspace !== runtime.workspace) {
    ttyChannels.observation(
      `保存会話の workspace=${existingState.workspace} と今回の workspace=${runtime.workspace} が異なります。起動 cwd の違いでは中断せず、今回の workspace で再開を試みます。`,
    );
  }
  if (existingState && existingState.backend !== runtime.backend) {
    ttyChannels.observation(
      `保存会話の backend=${existingState.backend} と選択中 backend=${runtime.backend} が異なります。選択中 backend で再開を試みます。`,
    );
  }
  if (
    existingState?.piResourceRoots &&
    (existingState.piResourceRoots.agentDir !== runtime.piResourceRoots.agentDir ||
      existingState.piResourceRoots.projectDir !== runtime.piResourceRoots.projectDir)
  ) {
    ttyChannels.observation(
      '保存会話の Pi resource root と選択 profile の設定が異なります。選択中 root で再開を試みます。',
    );
  }
  const operatorAgentId = existingState?.operatorAgentId ?? `operator-${randomUUID()}`;
  const watchPool = await createOperatorWatchPool({
    userEnsembleRoot: runtime.userEnsembleRoot,
    profile: runtime.profileName,
    profileIncludes: runtime.profile.include,
    repoFilters: runtime.repoFilters,
    dispatchQueue,
    onError: (message) =>
      ttyChannels.harness(`watch warning: ${message}`),
  });

  const agentOptions = {
    cwd: runtime.workspace,
    systemPrompt: runtime.systemPrompt,
    modelId: runtime.modelId,
    ...(runtime.reasoning !== undefined
      ? { reasoning: runtime.reasoning }
      : {}),
    ...(runtime.mcpServers ? { mcpServers: runtime.mcpServers } : {}),
    // The operator role has no repository editing or shell tools in Phase 1.
    builtinTools: false,
    ...(runtime.backend === 'cursor'
      ? { disableCursorAmbientSettings: true }
      : {}),
    ...(runtime.backend === 'pi'
      ? {
          pi: runtime.piResourceRoots,
          sessionDir: operatorPiSessionDirectory(
            runtime.userEnsembleRoot,
            operatorAgentId,
          ),
          piSkills: runtime.profile.pi?.skills !== false,
          piExtensions: false,
          operatorPiMcpMode: 'direct' as const,
        }
      : {}),
    customTools: {
      list_operator_sessions: createListOperatorSessionsTool(
        {
          userEnsembleRoot: runtime.userEnsembleRoot,
          profileIncludes: runtime.profile.include,
          repoFilters: runtime.repoFilters,
          getGitHubClient: () =>
            createGitHubClient({
              config: DEFAULT_ENSEMBLE_CONFIG,
              signal: AbortSignal.timeout(8_000),
            }),
        },
        (conductorAgentId) => watchPool.getLiveStatus(conductorAgentId),
        reportResumeStoreDuplicate,
        (conductorAgentId, issueUrl) =>
          watchPool.getSessionTrackingInfo(conductorAgentId, issueUrl),
      ),
      list_live_open_questions: createListLiveOpenQuestionsTool(
        { userEnsembleRoot: runtime.userEnsembleRoot },
        reportResumeStoreDuplicate,
      ),
      answer_live_open_question: createAnswerLiveOpenQuestionTool(
        { userEnsembleRoot: runtime.userEnsembleRoot },
        reportResumeStoreDuplicate,
      ),
      get_last_conductor_message: createGetLastConductorMessageTool(
        { userEnsembleRoot: runtime.userEnsembleRoot },
        reportResumeStoreDuplicate,
      ),
      list_conductor_messages: createListConductorMessagesTool(
        { userEnsembleRoot: runtime.userEnsembleRoot },
        reportResumeStoreDuplicate,
      ),
      list_worker_messages: createListWorkerMessagesTool({
        userEnsembleRoot: runtime.userEnsembleRoot,
      }),
      register_session_watch: createRegisterSessionWatchTool(watchPool),
      unregister_session_watch: createUnregisterSessionWatchTool(watchPool),
      register_repository_watch:
        createRegisterRepositoryWatchTool(watchPool),
      unregister_repository_watch:
        createUnregisterRepositoryWatchTool(watchPool),
      register_conductor_message_listen:
        createRegisterConductorMessageListenTool(watchPool),
      unregister_conductor_message_listen:
        createUnregisterConductorMessageListenTool(watchPool),
      set_report_hold: createSetReportHoldTool(dispatchQueue),
      release_reports: createReleaseReportsTool(dispatchQueue),
      set_session_focus: createSetSessionFocusTool(dispatchQueue),
      send_operator_message: createSendOperatorMessageTool(
        { userEnsembleRoot: runtime.userEnsembleRoot },
        reportResumeStoreDuplicate,
      ),
      shutdown_issue_session: createShutdownIssueSessionTool(
        { userEnsembleRoot: runtime.userEnsembleRoot },
        reportResumeStoreDuplicate,
      ),
      ...workspaceFileTools,
    },
  };
  let agent: ConductorAgent;
  try {
    agent = existingState
      ? await factory.resume(existingState.providerSessionId, agentOptions)
      : await factory.create(agentOptions);
  } catch (error) {
    watchPool.close();
    for (const entry of ttyLogRouter.drain()) {
      const leadingBlank = entry.options?.leadingBlank === false ? '' : '\n';
      stdout.write(`${leadingBlank}[${entry.channel}] ${entry.detail}\n`);
    }
    throw error;
  }

  const agentHandle: OperatorAgentHandle = {
    conductor: agent,
    factory,
    agentOptions,
  };
  const recoveryInbox = new ConductorRecoveryInbox();
  const dispatchLifecycle =
    new ConductorDispatchLifecycle<OperatorAgentDispatchPayload>();
  const operatorCanInspectRecovery = Boolean(
    stdin.isTTY && stdout.isTTY && stderr.isTTY,
  );
  try {
    const now = Date.now();
    const state: OperatorAgentState = {
      version: 2,
      operatorAgentId,
      providerSessionId: agent.agentId,
      backend: runtime.backend,
      profile: runtime.profileName,
      workspace: runtime.workspace,
      ...(runtime.backend === 'pi'
        ? { piResourceRoots: runtime.piResourceRoots }
        : {}),
      createdAt: existingState?.createdAt ?? now,
      updatedAt: now,
    };
    await saveOperatorAgentState(runtime.userEnsembleRoot, state);
    ttyChannels.observation(
      `operatorAgentId=${operatorAgentId} を${existingState ? '再開' : '作成'}しました。次回は --resume ${operatorAgentId} で選べます。`,
    );
    const exitContinuity = await runTtyConversation({
      agentHandle,
      backend: runtime.backend,
      systemPrompt: runtime.systemPrompt,
      stdin,
      stdout,
      stderr,
      ttyLogRouter,
      dispatchQueue,
      watchPool,
      recoveryInbox,
      dispatchLifecycle,
      operatorCanInspectRecovery,
      scheduling: runtime.scheduling,
      colorEnabled:
        Boolean(stdin.isTTY && stdout.isTTY) && process.env.NO_COLOR === undefined,
    });
    if (exitContinuity) {
      await clearOperatorAgentState(runtime.userEnsembleRoot, operatorAgentId);
    }
  } finally {
    recoveryInbox.dispose();
    watchPool.close();
    await closeConductorAgentOnce(agentHandle.conductor);
  }
}

async function resolveOperatorRuntime(
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
  const systemPrompt = renderCompiledPrompt(
    compile(
      promptModule,
      {
        workspace,
        backend,
        profileName: selectedProfileName,
      },
    ),
  );

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

function addOperatorMcpStartupContext(
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

async function selectSavedConversation(
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

async function runTtyConversation(options: {
  agentHandle: OperatorAgentHandle;
  backend: ConductorBackend;
  systemPrompt: string;
  stdin: OperatorAgentInput;
  stdout: OperatorAgentOutput;
  stderr: OperatorAgentOutput;
  ttyLogRouter: OperatorTtyLogRouter;
  dispatchQueue: ReturnType<typeof createOperatorDispatchQueue>;
  watchPool: OperatorWatchPool;
  recoveryInbox: ConductorRecoveryInbox;
  dispatchLifecycle: ConductorDispatchLifecycle<OperatorAgentDispatchPayload>;
  operatorCanInspectRecovery: boolean;
  scheduling: Required<OperatorAgentSchedulingConfig>;
  colorEnabled: boolean;
}): Promise<boolean> {
  let cursorBootstrapComplete = options.backend !== 'cursor';
  let stop: () => void = () => {};
  let exitContinuity = false;
  let inputEnded = false;
  let pendingReconnects = 0;
  let sendCount = 0;
  let agentSendInFlight = false;
  const automaticReconnectResult: {
    current?: ConductorRecoveryReconnect;
  } = {};
  let recoveryCapacityNoticeSent = false;
  let shownHoldStatus = formatReportHoldStatus(options.dispatchQueue);
  const stopping = new Promise<void>((resolve) => {
    stop = resolve;
  });
  const sendSuppression = new AbortController();
  let handleInput = (_message: string) => {};
  let tui: ReturnType<typeof createOperatorAgentTuiHost>;
  const requestStop = (exitCode?: number) => {
    if (exitCode !== undefined) process.exitCode = exitCode;
    sendSuppression.abort();
    tui.setInputEnabled(false);
    stop();
  };
  tui = createOperatorAgentTuiHost({
    stdin: options.stdin,
    stdout: options.stdout,
    colorEnabled: options.colorEnabled,
    onSubmit: (message) => handleInput(message),
    onInterrupt: () => requestStop(130),
  });
  const unsubscribeTtyLogRouter = options.ttyLogRouter.attach((entry) => {
    tui.appendChannel(entry.channel, entry.detail, entry.options);
  });
  const writeChannelLine = (
    channel: keyof OperatorTtyChannels,
    detail: string,
    displayOptions: OperatorAgentTuiLogOptions = {},
  ) => tui.appendChannel(channel, detail, displayOptions);
  const waitForAcknowledgementRetry = (delayMs: number) =>
    new Promise<boolean>((resolve) => {
      let settled = false;
      let timer: NodeJS.Timeout;
      const finish = (stopped: boolean) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve(stopped);
      };
      timer = setTimeout(() => finish(false), delayMs);
      void stopping.then(() => finish(true));
    });
  const unsubscribeHoldChanges = options.dispatchQueue.subscribe(() => {
    const nextStatus = formatReportHoldStatus(options.dispatchQueue);
    if (nextStatus === shownHoldStatus) return;
    shownHoldStatus = nextStatus;
    writeChannelLine('harness', nextStatus);
  });
  const wakeDispatch = () => options.dispatchQueue.wake();
  const unsubscribeLifecycle = options.dispatchLifecycle.subscribe(wakeDispatch);
  const unsubscribeRecoveryInbox = options.recoveryInbox.subscribe(wakeDispatch);
  const recoveryCommandApi = {
    listRecoverySnapshots: () => options.recoveryInbox.list(),
    ...(options.operatorCanInspectRecovery
      ? {
          getRecoverySnapshot: (recoveryId: string) =>
            options.recoveryInbox.get(recoveryId),
        }
      : {}),
    clearRecoverySnapshot: (recoveryId: string) =>
      options.recoveryInbox.remove(recoveryId),
    continueAfterRecovery: () => options.dispatchLifecycle.confirmRecovery(),
    recoveryAttentionAttemptId: () =>
      options.dispatchLifecycle.pendingAttemptId,
  };
  const handleRecoveryCommand = (message: string): boolean => {
    const recoveryCommand = executeRecoveryInboxCommand(
      recoveryCommandApi,
      message,
      {
        canDisplaySensitiveContent: options.operatorCanInspectRecovery,
      },
    );
    if (!recoveryCommand.handled) return false;
    if (recoveryCommand.inspection) {
      writeChannelLine(
        'harness',
        `${recoveryCommand.inspection.title}\n${recoveryCommand.inspection.text}`,
      );
    }
    return true;
  };
  const handleInterrupt = () => requestStop(130);
  const handleTermination = () => requestStop(143);
  const handleInputEnd = () => {
    inputEnded = true;
    options.dispatchQueue.wake();
  };
  const handleSubmittedInput = (rawMessage: string) => {
    const message = rawMessage;
    const normalizedMessage = message.trim();
    if (!normalizedMessage || inputEnded) return;
    options.dispatchQueue.noteOperatorInput();
    tui.appendUserMessage(message);
    if (handleRecoveryCommand(normalizedMessage)) return;
    const focusCommand = /^\/focus(?:\s+(\S+))?$/u.exec(normalizedMessage);
    if (focusCommand) {
      if (!focusCommand[1]) {
        writeChannelLine(
          'observation',
          `focus: ${options.dispatchQueue.focusSessionId ?? 'off'}。使い方: /focus <conductorAgentId> または /focus-off`,
        );
        return;
      }
      options.dispatchQueue.setFocus(focusCommand[1]);
      writeChannelLine(
        'observation',
        `focus を ${focusCommand[1]} に設定しました。focus session の全 report を優先し、focus 外の Open Question が待つ場合があります。`,
      );
      return;
    }
    if (normalizedMessage === '/focus-off') {
      options.dispatchQueue.setFocus(undefined);
      writeChannelLine('observation', 'focus を解除しました。');
      return;
    }
    if (isOperatorCommand(normalizedMessage, 'exit')) {
      exitContinuity = true;
      inputEnded = true;
      tui.setInputEnabled(false);
      writeChannelLine('observation', 'session ended.');
      options.dispatchQueue.wake();
      return;
    }
    if (isOperatorCommand(normalizedMessage, 'reconnect')) {
      pendingReconnects += 1;
      options.dispatchQueue.wake();
      return;
    }
    if (isResumeWatchCommand(normalizedMessage)) {
      options.dispatchQueue.setConversationHold(false);
      return;
    }
    if (!options.dispatchQueue.enqueueUser(message)) {
      writeChannelLine(
        'harness',
        'recovery inbox の完全保持に合わせ、1 MiB を超える入力は受け付けません。短くするか分割してから送信してください。',
        { color: ANSI_RED },
      );
      return;
    }
    options.dispatchQueue.setConversationHold(true);
  };
  handleInput = handleSubmittedInput;
  options.stdin.on('end', handleInputEnd);
  process.on('SIGINT', handleInterrupt);
  process.on('SIGTERM', handleTermination);
  writeChannelLine(
    'observation',
    `(${options.backend}) ready — enter /exit to start a fresh session next time. Focus: /focus <conductorAgentId> /focus-off.`,
    { leadingBlank: false },
  );
  const dispatchState: OperatorDispatchState = {
    continuationConsumed: false,
  };
  const idleCandidateMonitor = createOperatorIdleCandidateMonitor({
    watchPool: options.watchPool,
    dispatchQueue: options.dispatchQueue,
    scheduling: options.scheduling,
    isAgentSendInFlight: () => agentSendInFlight,
    onError: (message) => writeChannelLine('harness', message),
    refreshOnGateClear: async (knownObservationVersions) => {
      for (const watch of options.watchPool.list()) {
        if (
          agentSendInFlight ||
          options.dispatchQueue.pendingUserCount > 0 ||
          options.dispatchQueue.conversationHold ||
          options.dispatchQueue.focusSessionId !== undefined
        ) {
          return;
        }
        try {
          const refreshCandidateObservation =
            options.watchPool.refreshIdleCandidateObservation;
          if (!refreshCandidateObservation) {
            writeChannelLine(
              'harness',
              `idle candidate refresh is unavailable for ${watch.conductorAgentId}`,
            );
            return;
          }
          await refreshCandidateObservation(
            watch.conductorAgentId,
            knownObservationVersions.get(watch.conductorAgentId) ?? 0,
          );
        } catch (error) {
          writeChannelLine(
            'harness',
            `idle candidate state refresh failed for ${watch.conductorAgentId}: ${error instanceof Error ? error.message : String(error)}`,
          );
        }
      }
    },
  });

  try {
    while (true) {
      if (
        inputEnded &&
        options.dispatchQueue.pendingUserCount === 0 &&
        pendingReconnects === 0
      ) {
        return exitContinuity;
      }
      if (pendingReconnects > 0) {
        pendingReconnects -= 1;
        const reconnectLease = options.dispatchLifecycle.beginReconnect();
        if (!reconnectLease) {
          pendingReconnects += 1;
          const didStop = await Promise.race([
            options.dispatchQueue.waitForChange().then(() => false),
            stopping.then(() => true),
          ]);
          if (didStop) return exitContinuity;
          continue;
        }
        const failureClass =
          options.dispatchLifecycle.lastFailure ?? 'none';
        let reconnectReported = false;
        try {
          await reconnectConductorAgent(options.agentHandle, {
            conductorAgentFactory: options.agentHandle.factory,
            conductorOptions: options.agentHandle.agentOptions,
            source: 'manual',
            signal: sendSuppression.signal,
            onReconnectAttempt: ({ agentId, source }) => {
              writeChannelLine(
                'harness',
                `conductor の再接続を開始します。agentId=${agentId} source=${source} failure=${failureClass}`,
              );
            },
            onReconnectComplete: ({
              agentId,
              success,
              source,
              error,
              closeFailed,
            }) => {
              reconnectReported = true;
              const errorDetail =
                !success && error
                  ? ` error=${escapeTerminalControlCharacters(error)}`
                  : '';
              const cleanupDetail = closeFailed
                ? ' 旧 conductor の終了処理に失敗したため、リソース解放は確認できません。'
                : '';
              const message =
                `${success ? 'conductor に再接続しました。' : 'conductor の再接続に失敗しました。'}` +
                `agentId=${agentId} source=${source} failure=${failureClass}` +
                `${errorDetail}${cleanupDetail}`;
              writeChannelLine(
                success ? 'observation' : 'harness',
                message,
                success ? {} : { color: ANSI_RED },
              );
            },
          });
          options.dispatchLifecycle.settleReconnect(reconnectLease, true);
        } catch {
          options.dispatchLifecycle.settleReconnect(reconnectLease, false);
          if (!reconnectReported && !sendSuppression.signal.aborted) {
            writeChannelLine(
              'harness',
              `conductor の再接続に失敗しました。source=manual failure=${failureClass}`,
              { color: ANSI_RED },
            );
          }
        }
        continue;
      }
      if (!options.dispatchLifecycle.canDispatch) {
        const didStop = await Promise.race([
          options.dispatchQueue.waitForChange().then(() => false),
          stopping.then(() => true),
        ]);
        if (didStop) return exitContinuity;
        continue;
      }
      // Let gate-clear candidate refresh/admission coalesce with a ready batch
      // for at most its aggregate policy cap before selecting and freezing.
      if (options.dispatchQueue.pendingUserCount === 0) {
        await idleCandidateMonitor.waitForGateRefresh();
      }
      if (
        inputEnded &&
        options.dispatchQueue.pendingUserCount === 0 &&
        pendingReconnects === 0
      ) {
        return exitContinuity;
      }
      const batch = options.dispatchQueue.selectBatch(dispatchState);
      if (!batch) {
        const readyAt = options.dispatchQueue.nextReadyAt();
        const waitMs =
          readyAt === undefined
            ? undefined
            : Math.max(0, readyAt - Date.now());
        const didStop = await Promise.race([
          options.dispatchQueue.waitForChange(waitMs).then(() => false),
          stopping.then(() => true),
        ]);
        if (didStop) return exitContinuity;
        continue;
      }
      const operatorInputTexts = batch.events.flatMap((event) =>
        event.type === 'user' ? [event.text] : [],
      );
      const reservationResult = options.operatorCanInspectRecovery
        ? options.recoveryInbox.reserve(operatorInputTexts)
        : { ok: true as const, reservation: undefined };
      if (!reservationResult.ok) {
        if (reservationResult.reason === 'input_too_large') {
          writeChannelLine(
            'harness',
            '入力が recovery inbox の上限を超えています。選択中の入力は queue に残しています。',
            { color: ANSI_RED },
          );
        } else if (!recoveryCapacityNoticeSent) {
          recoveryCapacityNoticeSent = true;
          writeChannelLine(
            'harness',
            'recovery inbox の容量が上限です。選択中の入力は queue に残しています。/recovery clear <id> で空きを作るか、30 分後の期限切れを待ちます。',
          );
        }
        const didStop = await Promise.race([
          options.dispatchQueue.waitForChange().then(() => false),
          stopping.then(() => true),
        ]);
        if (didStop) return exitContinuity;
        continue;
      }
      recoveryCapacityNoticeSent = false;
      const reservation = reservationResult.reservation;
      const lease = options.dispatchLifecycle.beginSend({ batch });
      if (!lease) {
        if (reservation) options.recoveryInbox.release(reservation);
        continue;
      }
      // Keep candidate generation gated while the selected batch is frozen.
      // Committing removes its user event before agent.send begins, so that
      // gap must not look like an actual gate-clear edge.
      agentSendInFlight = true;
      idleCandidateMonitor.notifyActivityChanged();
      let committed: boolean;
      try {
        committed = await options.watchPool.commitBatch(batch, dispatchState);
      } catch (error) {
        agentSendInFlight = false;
        idleCandidateMonitor.notifyActivityChanged();
        if (reservation) options.recoveryInbox.release(reservation);
        options.dispatchLifecycle.settleSend(lease, {
          completed: false,
          requiresConfirmation: false,
        });
        throw error;
      }
      if (!committed) {
        agentSendInFlight = false;
        idleCandidateMonitor.notifyActivityChanged();
        if (reservation) options.recoveryInbox.release(reservation);
        options.dispatchLifecycle.settleSend(lease, { completed: true });
        continue;
      }

      // The watch pool resolves only after the frozen manifest is durable.
      // Keep this path synchronous until sendConductorWithReconnect is invoked.
      const prompt =
        options.backend === 'cursor' && !cursorBootstrapComplete
          ? `${options.systemPrompt}\n\n## User message\n\n${batch.payload ?? formatOperatorDispatchBatch(batch.events)}`
          : batch.payload ?? formatOperatorDispatchBatch(batch.events);
      writeChannelLine('harness', 'operator: 処理中');
      const nextSendCount = sendCount + 1;
      let toolCallStarted = false;
      automaticReconnectResult.current = undefined;
      let result: ConductorSendResult | undefined;
      try {
        result = await Promise.race([
          sendConductorWithReconnect(
            options.agentHandle,
            prompt,
            {
              conductorAgentFactory: options.agentHandle.factory,
              conductorOptions: options.agentHandle.agentOptions,
              signal: sendSuppression.signal,
              onToolCallStarted: ({ tool }) => {
                toolCallStarted = true;
                writeChannelLine(
                  'harness',
                  `operator: calling ${formatOperatorToolName(tool)}`,
                );
              },
              onAuthReconnectAttempt: ({ agentId, source }) => {
                writeChannelLine(
                  'harness',
                  `[auth] conductor reconnect attempt agentId=${agentId} source=${source ?? 'automatic'}`,
                );
              },
              onAuthReconnectComplete: ({ success, source, closeFailed }) => {
                options.dispatchLifecycle.setAgentAvailable(success);
                automaticReconnectResult.current = {
                  reason: 'auth',
                  succeeded: success,
                };
                writeChannelLine(
                  success ? 'observation' : 'harness',
                  `[auth] conductor reconnect ${success ? 'succeeded' : 'failed'} source=${source ?? 'automatic'}${closeFailed ? ' old agent close failed; cleanup is unconfirmed' : ''}`,
                  success ? {} : { color: ANSI_RED },
                );
              },
              onTransportReconnectAttempt: ({ agentId, source }) => {
                writeChannelLine(
                  'harness',
                  `[transport] conductor reconnect attempt agentId=${agentId} source=${source ?? 'automatic'}`,
                );
              },
              onTransportReconnectComplete: ({
                success,
                source,
                closeFailed,
              }) => {
                options.dispatchLifecycle.setAgentAvailable(success);
                automaticReconnectResult.current = {
                  reason: 'transport',
                  succeeded: success,
                };
                writeChannelLine(
                  success ? 'observation' : 'harness',
                  `[transport] conductor reconnect ${success ? 'succeeded' : 'failed'} source=${source ?? 'automatic'}${closeFailed ? ' old agent close failed; cleanup is unconfirmed' : ''}`,
                  success ? {} : { color: ANSI_RED },
                );
              },
            },
          ).catch(() => {
            // Keep the shared helper's rejected-promise API. This workflow owns
            // the unknown-outcome transition and omits the raw error.
            return { runId: '', status: 'send_rejected' } as ConductorSendResult;
          }),
          stopping.then(() => undefined),
        ]);
      } finally {
        agentSendInFlight = false;
        idleCandidateMonitor.notifyActivityChanged();
      }
      if (!result) {
        if (reservation) options.recoveryInbox.release(reservation);
        return exitContinuity;
      }
      sendCount = nextSendCount;
      dispatchState.lastDispatchedSourceKey = batch.sourceKey;
      dispatchState.continuationConsumed = batch.usedContinuation;
      const sendCompleted =
        result.status === 'finished' || result.status === 'completed';
      if (sendCompleted) cursorBootstrapComplete = true;
      const settled = settleConductorDispatch({
        lifecycle: options.dispatchLifecycle,
        lease,
        inbox: options.recoveryInbox,
        ...(reservation ? { reservation } : {}),
        workflow: 'operator-agent',
        backend: options.backend,
        sendCount,
        sourceKey: batch.sourceKey,
        eventTypes: batch.events.map((event) =>
          event.type === 'user' ? 'operator.message' : `watch.${event.reportType}`,
        ),
        operatorInputTexts,
        result,
        ...(automaticReconnectResult.current
          ? { automaticReconnect: automaticReconnectResult.current }
          : {}),
        toolCallStarted,
        captureFailure: options.operatorCanInspectRecovery,
        requiresConfirmation: operatorInputTexts.length > 0,
        ...(result.status === 'send_rejected'
          ? { agentAvailable: false }
          : {}),
      });
      automaticReconnectResult.current = undefined;
      if (sendCompleted) {
        const acknowledgement = await retryOperatorWatchAcknowledgement(
          () => options.watchPool.acknowledge(batch.events),
          waitForAcknowledgementRetry,
          (retryNumber) => {
            writeChannelLine(
              'harness',
              `監視報告の ack 保存に失敗しました。完了済み turn は再送せず、${OPERATOR_WATCH_ACK_RETRY_DELAY_MS / 1_000} 秒後に ack だけを再試行します（${retryNumber}/${OPERATOR_WATCH_ACK_MAX_RETRIES}）。`,
              { color: ANSI_RED },
            );
          },
        );
        if (acknowledgement.status === 'stopped') {
          return exitContinuity;
        }
        if (acknowledgement.status === 'exhausted') {
          const message =
            `監視報告の ack 保存に${OPERATOR_WATCH_ACK_MAX_RETRIES}回の retry 後も失敗しました。` +
            'pending state は保持されています。重複 turn を避けるため runner を停止します。' +
            '再起動後は同じ report ID を再送する場合があります。';
          writeChannelLine('harness', message, { color: ANSI_RED });
          // Commit the final Static log entry before teardown unmounts Ink.
          await new Promise<void>((resolve) => setImmediate(resolve));
          requestStop(1);
          throw new Error(
            `Operator watch report acknowledgement failed after ${OPERATOR_WATCH_ACK_MAX_RETRIES} retries; pending reports were retained. Restart may redeliver the same report IDs.`,
            { cause: acknowledgement.error },
          );
        }
      } else {
        const retryReadyAt = Date.now() + 5_000;
        await options.watchPool.recordRetry?.(batch.events, retryReadyAt);
        for (const event of batch.events) {
          if (event.type === 'report') options.dispatchQueue.requeue(event, 5_000);
        }
        if (operatorInputTexts.length > 0) {
          const recoveryDetails = options.operatorCanInspectRecovery
            ? settled.snapshot
              ? `失敗した入力は ${settled.snapshot.recoveryId} として保持しています。/recovery show ${settled.snapshot.recoveryId} で確認し、状態確認後に /recovery continue を実行してください。`
              : 'この入力の recovery snapshot は作成されていません。'
            : 'この実行環境では recovery 本文を確認できず、同一 process 内でも取得できません。';
          writeChannelLine(
            'harness',
            `operator send が未完了です (status=${escapeTerminalControlCharacters(result.status)}, failure=${settled.failureClass ?? 'unknown'})。失敗した入力は queue に戻していません。${recoveryDetails}`,
            { color: ANSI_RED },
          );
        }
        if (result.status === 'error') {
          writeChannelLine(
            'harness',
            result.error?.message ?? result.result ?? 'request failed',
            { color: ANSI_RED },
          );
          if (
            options.backend === 'pi' &&
            isConductorSendAuthError(result)
          ) {
            const provider =
              (await resolvePiConductorProvider({
                cwd: options.agentHandle.agentOptions.cwd,
                modelId: options.agentHandle.agentOptions.modelId,
                pi: options.agentHandle.agentOptions.pi,
              }).catch(() => undefined)) || undefined;
            options.stderr.write(
              `${formatConductorAuthRecoveryHint(
                options.agentHandle.conductor.agentId,
                {
                  backend: 'pi',
                  provider,
                  pi: options.agentHandle.agentOptions.pi,
                  resumeInstruction:
                    '認証設定を直した後に `ensemble operator-agent` で /reconnect を実行してください。',
                },
              )}\n`,
            );
          }
        } else if (result.status === 'send_rejected') {
          writeChannelLine(
            'harness',
            'send() が reject されました。provider 側の結果は不明です。明示的に /reconnect するまで conductor への送信を停止します。',
            { color: ANSI_RED },
          );
        } else {
          writeChannelLine(
            'harness',
            `send not completed (status=${escapeTerminalControlCharacters(result.status)}); watched reports retained for retry.`,
          );
        }
      }
      if (sendCompleted && result.result?.trim()) {
        const response = normalizeOperatorResponse(result.result);
        tui.appendOperatorResponse(response);
      } else if (sendCompleted) {
        writeChannelLine(
          'observation',
          `completed (status: ${escapeTerminalControlCharacters(result.status)}).`,
        );
      }
      if (
        sendCompleted &&
        batch.events.some((event) => event.type === 'user') &&
        options.dispatchQueue.conversationHold &&
        options.dispatchQueue.pendingUserCount === 0
      ) {
        options.dispatchQueue.setConversationHold(false);
      }
    }
  } finally {
    options.stdin.off('end', handleInputEnd);
    process.off('SIGINT', handleInterrupt);
    process.off('SIGTERM', handleTermination);
    tui.setInputEnabled(false);
    idleCandidateMonitor.close();
    await tui.dispose();
    unsubscribeTtyLogRouter();
    unsubscribeHoldChanges();
    unsubscribeLifecycle();
    unsubscribeRecoveryInbox();
  }
}

function formatReportHoldStatus(
  queue: ReturnType<typeof createOperatorDispatchQueue>,
): string {
  const reasons = [
    queue.conversationHold ? '会話' : undefined,
    queue.reportHold ? '手動' : undefined,
  ].filter((reason): reason is string => reason !== undefined);
  return [
    `監視報告: ${queue.hold ? '保留' : '解除'}`,
    `（理由: ${reasons.join('・') || 'なし'}、保留件数: ${queue.heldEventCount} 件）`,
  ].join('');
}

function createOperatorTtyLogRouter(): OperatorTtyLogRouter {
  const pending: OperatorTtyLogEntry[] = [];
  let sink: ((entry: OperatorTtyLogEntry) => void) | undefined;
  return {
    append: (channel, detail, options) => {
      const entry: OperatorTtyLogEntry = { channel, detail, options };
      if (sink) sink(entry);
      else pending.push(entry);
    },
    attach: (nextSink) => {
      sink = nextSink;
      for (const entry of pending.splice(0)) nextSink(entry);
      return () => {
        if (sink === nextSink) sink = undefined;
      };
    },
    drain: () => pending.splice(0),
  };
}

function isResumeWatchCommand(message: string): boolean {
  const normalized = message.toLocaleLowerCase();
  return normalized === '/resume-watch' || normalized === 'resume-watch';
}

function normalizeOperatorResponse(response: string): string {
  return response.trim().replace(/\r\n?/g, '\n').replace(/\n{3,}/g, '\n\n');
}

function formatOperatorToolName(tool: string): string {
  return tool.replace(/[\u0000-\u001f\u007f-\u009f]/g, ' ').trim() || 'unknown';
}

function assertTty(stdin: OperatorAgentInput, stdout: OperatorAgentOutput): void {
  if (!stdin.isTTY || !stdout.isTTY) {
    throw new Error(
      'ensemble operator-agent requires an interactive TTY on stdin and stdout.',
    );
  }
}
