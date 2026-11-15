import { clearLine, createInterface, cursorTo } from 'node:readline';
import { mkdir } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { compile, merge } from '@modular-prompt/core';
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
import { createListOperatorSessionsTool } from './list-operator-sessions-tool.js';
import {
  createReleaseReportsTool,
  createSetReportHoldTool,
} from './operator-control-tools.js';
import {
  createOperatorWatchPool,
  createRegisterConductorMessageListenTool,
  createRegisterSessionWatchTool,
  createUnregisterConductorMessageListenTool,
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
} from './operator-agent-config.js';
import { resolveOperatorAgentMcpServers } from './operator-agent-mcp.js';

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
}

export interface OperatorAgentOutput extends NodeJS.WritableStream {
  isTTY?: boolean;
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

const ANSI_RESET = '\u001b[0m';
const ANSI_DIM = '\u001b[2m';
const ANSI_CYAN = '\u001b[36m';
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

  const ttyChannels: OperatorTtyChannels = {
    harness: (detail) => stdout.write(`\n[harness] ${detail}\n\n`),
    observation: (detail) => stdout.write(`\n[observation] ${detail}\n\n`),
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
    { stdin, stdout },
  );
  const workspaceFileTools = createOperatorWorkspaceFileTools(
    await resolveOperatorWorkspaceRoot(runtime.workspace),
  );
  const factory = addOperatorMcpStartupContext(
    dependencies.agentFactory ?? createConductorAgentFactory(runtime.backend),
  );
  const dispatchQueue = createOperatorDispatchQueue();
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
        }
      : {}),
    customTools: {
      list_operator_sessions: createListOperatorSessionsTool(
        {
          userEnsembleRoot: runtime.userEnsembleRoot,
          profileIncludes: runtime.profile.include,
          repoFilters: runtime.repoFilters,
        },
        (conductorAgentId) => watchPool.getLiveStatus(conductorAgentId),
        reportResumeStoreDuplicate,
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
      register_conductor_message_listen:
        createRegisterConductorMessageListenTool(watchPool),
      unregister_conductor_message_listen:
        createUnregisterConductorMessageListenTool(watchPool),
      set_report_hold: createSetReportHoldTool(dispatchQueue),
      release_reports: createReleaseReportsTool(dispatchQueue),
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
      dispatchQueue,
      watchPool,
      ttyChannels,
      recoveryInbox,
      dispatchLifecycle,
      operatorCanInspectRecovery,
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
  tty?: { stdin: OperatorAgentInput; stdout: OperatorAgentOutput },
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
  tty?: { stdin: OperatorAgentInput; stdout: OperatorAgentOutput },
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
    tty?.stdout.write(
      `\n[observation] 保存会話の profile=${existingState.profile} は現在の operator config にありません。利用可能な profile を選びます。\n\n`,
    );
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
  dispatchQueue: ReturnType<typeof createOperatorDispatchQueue>;
  watchPool: OperatorWatchPool;
  ttyChannels: OperatorTtyChannels;
  recoveryInbox: ConductorRecoveryInbox;
  dispatchLifecycle: ConductorDispatchLifecycle<OperatorAgentDispatchPayload>;
  operatorCanInspectRecovery: boolean;
  colorEnabled: boolean;
}): Promise<boolean> {
  const terminal = createInterface({
    input: options.stdin,
    output: options.stdout,
    terminal: true,
    crlfDelay: Infinity,
  });
  terminal.setPrompt(`${colorize('user>', ANSI_DIM, options.colorEnabled)} `);
  let cursorBootstrapComplete = options.backend !== 'cursor';
  let stop: () => void = () => {};
  let exitContinuity = false;
  let inputEnded = false;
  let pendingReconnects = 0;
  let sendCount = 0;
  const automaticReconnectResult: {
    current?: ConductorRecoveryReconnect;
  } = {};
  let recoveryCapacityNoticeSent = false;
  let promptVisible = false;
  let terminalClosed = false;
  let shownHoldStatus = formatReportHoldStatus(options.dispatchQueue);
  const stopping = new Promise<void>((resolve) => {
    stop = resolve;
  });
  const sendSuppression = new AbortController();
  const requestStop = (exitCode?: number) => {
    if (exitCode !== undefined) process.exitCode = exitCode;
    sendSuppression.abort();
    terminal.close();
    stop();
  };
  const writeChannelLine = (
    channel: keyof OperatorTtyChannels,
    detail: string,
    displayOptions: { color?: string; leadingBlank?: boolean } = {},
  ) => {
    const color = displayOptions.color ?? ANSI_DIM;
    const line = `${colorize(`[${channel}]`, color, options.colorEnabled)} ${detail}`;
    if (promptVisible) {
      clearLine(options.stdout, 0);
      cursorTo(options.stdout, 0);
      options.stdout.write(`${line}\n\n`);
      terminal.prompt(true);
    } else {
      options.stdout.write(
        `${displayOptions.leadingBlank === false ? '' : '\n'}${line}\n\n`,
      );
    }
  };
  options.ttyChannels.harness = (detail, displayOptions) =>
    writeChannelLine('harness', detail, displayOptions);
  options.ttyChannels.observation = (detail, displayOptions) =>
    writeChannelLine('observation', detail, displayOptions);
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
  terminal.on('SIGINT', handleInterrupt);
  terminal.on('close', () => {
    promptVisible = false;
    terminalClosed = true;
  });
  process.on('SIGINT', handleInterrupt);
  process.on('SIGTERM', handleTermination);
  writeChannelLine(
    'observation',
    `(${options.backend}) ready — enter /exit to start a fresh session next time.`,
    { leadingBlank: false },
  );
  const readInput = async () => {
    try {
      for await (const rawLine of terminal) {
        const message = rawLine.trim();
        if (!message) continue;
        if (handleRecoveryCommand(message)) continue;
        if (isOperatorCommand(message, 'exit')) {
          exitContinuity = true;
          clearLine(options.stdout, 0);
          cursorTo(options.stdout, 0);
          promptVisible = false;
          writeChannelLine('observation', 'session ended.');
          terminal.close();
          break;
        }
        if (isOperatorCommand(message, 'reconnect')) {
          pendingReconnects += 1;
          options.dispatchQueue.wake();
          continue;
        }
        if (isResumeWatchCommand(message)) {
          options.dispatchQueue.setConversationHold(false);
          continue;
        }
        if (!options.dispatchQueue.enqueueUser(message)) {
          writeChannelLine(
            'harness',
            'recovery inbox の完全保持に合わせ、1 MiB を超える入力は受け付けません。短くするか分割してから送信してください。',
            { color: ANSI_RED },
          );
          continue;
        }
        options.dispatchQueue.setConversationHold(true);
      }
    } finally {
      inputEnded = true;
      options.dispatchQueue.wake();
    }
  };
  const inputTask = readInput();
  if (!terminalClosed) {
    terminal.prompt();
    promptVisible = true;
  }
  const dispatchState: OperatorDispatchState = {
    continuationConsumed: false,
  };

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
      if (!options.dispatchQueue.commitBatch(batch)) {
        if (reservation) options.recoveryInbox.release(reservation);
        options.dispatchLifecycle.settleSend(lease, { completed: true });
        continue;
      }

      const prompt =
        options.backend === 'cursor' && !cursorBootstrapComplete
          ? `${options.systemPrompt}\n\n## User message\n\n${formatOperatorDispatchBatch(batch.events)}`
          : formatOperatorDispatchBatch(batch.events);
      writeChannelLine('harness', 'operator: 処理中');
      const nextSendCount = sendCount + 1;
      let toolCallStarted = false;
      automaticReconnectResult.current = undefined;
      const result = await Promise.race([
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
        await options.watchPool.acknowledge(batch.events);
      } else {
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
        clearLine(options.stdout, 0);
        cursorTo(options.stdout, 0);
        options.stdout.write(
          `\n${colorize('operator>', ANSI_CYAN, options.colorEnabled)}\n${response}\n\n`,
        );
        if (promptVisible) terminal.prompt(true);
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
    await inputTask.catch(() => {});
    terminal.off('SIGINT', handleInterrupt);
    process.off('SIGINT', handleInterrupt);
    process.off('SIGTERM', handleTermination);
    terminal.close();
    promptVisible = false;
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

function colorize(text: string, color: string, enabled: boolean): string {
  return enabled ? `${color}${text}${ANSI_RESET}` : text;
}

function assertTty(stdin: OperatorAgentInput, stdout: OperatorAgentOutput): void {
  if (!stdin.isTTY || !stdout.isTTY) {
    throw new Error(
      'ensemble operator-agent requires an interactive TTY on stdin and stdout.',
    );
  }
}
