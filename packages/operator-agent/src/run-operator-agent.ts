import { clearLine, createInterface, cursorTo } from 'node:readline';
import { resolve } from 'node:path';
import { compile, merge } from '@modular-prompt/core';
import {
  createConductorAgentFactory,
  filterMaterialsForKind,
  formatConductorAuthRecoveryHint,
  isConductorSendAuthError,
  isOperatorCommand,
  loadEnsembleConfig,
  loadProfile,
  profilePromptModule,
  reconnectConductorAgent,
  renderCompiledPrompt,
  resolvePiConductorProvider,
  resolveAgentPromptModule,
  resolveConductorBackendSetting,
  resolveConductorModelId,
  resolveConductorPiResourcePaths,
  resolveEnsemblePaths,
  sendConductorWithReconnect,
  sessionStateFromProfile,
  type ConductorAgent,
  type ConductorAgentCreateOptions,
  type ConductorAgentHandle,
  type ConductorAgentFactory,
  type ConductorBackend,
  type EnsembleConfig,
  type ResolvedProfile,
} from '@agents-ensemble/core/operator-runtime';
import { operatorBaseModule } from './operator-base-module.js';
import {
  createOperatorDispatchQueue,
  formatOperatorDispatchBatch,
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
} from './open-question-control-tools.js';
import {
  clearOperatorAgentState,
  loadOperatorAgentState,
  saveOperatorAgentState,
} from './operator-agent-state.js';

export interface RunOperatorAgentOptions {
  repoRoot?: string;
  configPath?: string;
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
  loadConfig?: typeof loadEnsembleConfig;
  loadProfile?: typeof loadProfile;
  agentFactory?: ConductorAgentFactory;
}

interface OperatorRuntime {
  repoRoot: string;
  config: EnsembleConfig;
  profile: ResolvedProfile;
  backend: ConductorBackend;
  modelId: string;
  systemPrompt: string;
}

interface OperatorAgentHandle extends ConductorAgentHandle {
  factory: ConductorAgentFactory;
  agentOptions: ConductorAgentCreateOptions;
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

  const runtime = await resolveOperatorRuntime(options, dependencies);
  const factory =
    dependencies.agentFactory ?? createConductorAgentFactory(runtime.backend);
  const dispatchQueue = createOperatorDispatchQueue();
  const ttyChannels: OperatorTtyChannels = {
    harness: (detail) => stdout.write(`\n[harness] ${detail}\n\n`),
    observation: (detail) => stdout.write(`\n[observation] ${detail}\n\n`),
  };
  const existingState = options.newSession
    ? undefined
    : await loadOperatorAgentState(runtime.repoRoot);
  if (existingState && existingState.repoRoot !== runtime.repoRoot) {
    throw new Error(
      `Operator-agent session belongs to ${existingState.repoRoot}, not ${runtime.repoRoot}.`,
    );
  }
  if (existingState && existingState.backend !== runtime.backend) {
    throw new Error(
      `Operator-agent session uses the ${existingState.backend} backend, but the current configuration selects ${runtime.backend}. ` +
        'Use --new to start a fresh session.',
    );
  }
  if (options.newSession) {
    await clearOperatorAgentState(runtime.repoRoot);
  }
  const watchPool = await createOperatorWatchPool({
    repoRoot: runtime.repoRoot,
    dispatchQueue,
    onError: (message) =>
      ttyChannels.harness(`watch warning: ${message}`),
  });

  const agentOptions = {
    cwd: runtime.repoRoot,
    systemPrompt: runtime.systemPrompt,
    modelId: runtime.modelId,
    // The operator role has no repository editing or shell tools in Phase 1.
    builtinTools: false,
    ...(runtime.backend === 'pi'
      ? {
          pi: resolveConductorPiResourcePaths({
            repoRoot: runtime.repoRoot,
            config: runtime.config,
          }),
          sessionDir: resolveEnsemblePaths({
            repoRoot: runtime.repoRoot,
          }).operatorPiSessionsDir,
          legacySessionDir: resolveEnsemblePaths({
            repoRoot: runtime.repoRoot,
          }).legacyPiSessionsDir,
          piSkills: runtime.profile.conductor?.piSkills !== false,
          piExtensions: false,
        }
      : {}),
    customTools: {
      list_operator_sessions: createListOperatorSessionsTool(
        runtime.repoRoot,
        (conductorAgentId) => watchPool.getLiveStatus(conductorAgentId),
      ),
      list_live_open_questions: createListLiveOpenQuestionsTool(runtime.repoRoot),
      answer_live_open_question: createAnswerLiveOpenQuestionTool(runtime.repoRoot),
      get_last_conductor_message: createGetLastConductorMessageTool(runtime.repoRoot),
      list_conductor_messages: createListConductorMessagesTool(runtime.repoRoot),
      register_session_watch: createRegisterSessionWatchTool(watchPool),
      unregister_session_watch: createUnregisterSessionWatchTool(watchPool),
      register_conductor_message_listen:
        createRegisterConductorMessageListenTool(watchPool),
      unregister_conductor_message_listen:
        createUnregisterConductorMessageListenTool(watchPool),
      set_report_hold: createSetReportHoldTool(dispatchQueue),
      release_reports: createReleaseReportsTool(dispatchQueue),
      send_operator_message: createSendOperatorMessageTool(runtime.repoRoot),
    },
  };
  let agent: ConductorAgent;
  try {
    agent = existingState
      ? await factory.resume(existingState.agentId, agentOptions)
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
  try {
    await saveOperatorAgentState(runtime.repoRoot, {
      version: 1,
      agentId: agent.agentId,
      backend: runtime.backend,
      repoRoot: runtime.repoRoot,
    });
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
      colorEnabled:
        Boolean(stdin.isTTY && stdout.isTTY) && process.env.NO_COLOR === undefined,
    });
    if (exitContinuity) {
      await clearOperatorAgentState(runtime.repoRoot);
    }
  } finally {
    watchPool.close();
    await agentHandle.conductor.close();
  }
}

async function resolveOperatorRuntime(
  options: RunOperatorAgentOptions,
  dependencies: RunOperatorAgentDependencies,
): Promise<OperatorRuntime> {
  const repoRoot = resolve(options.repoRoot ?? process.cwd());
  const config = await (dependencies.loadConfig ?? loadEnsembleConfig)(repoRoot, {
    ...(options.configPath !== undefined ? { configPath: options.configPath } : {}),
  });
  const { profile, profilePath } = await (dependencies.loadProfile ?? loadProfile)({
    cwd: repoRoot,
    config,
  });
  const backend = resolveConductorBackendSetting({ profile, config });
  const modelId = resolveConductorModelId(undefined, { config });
  const sessionState = sessionStateFromProfile(profile);
  const profileModule = profilePromptModule({
    agentModule: resolveAgentPromptModule('operator', profile.agents),
    materials: filterMaterialsForKind(sessionState.materials, 'operator'),
  });
  const promptModule = profileModule
    ? merge(operatorBaseModule, profileModule)
    : operatorBaseModule;
  const systemPrompt = renderCompiledPrompt(
    compile(
      promptModule,
      {
        repoRoot,
        conductorBackend: backend,
        profileName: profile.meta?.title ?? profilePath,
        workers: profile.workers.map(({ name, kind }) => ({ name, kind })),
      },
    ),
  );

  return { repoRoot, config, profile, backend, modelId, systemPrompt };
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
  colorEnabled: boolean;
}): Promise<boolean> {
  const terminal = createInterface({
    input: options.stdin,
    output: options.stdout,
    terminal: true,
    crlfDelay: Infinity,
  });
  terminal.setPrompt(`${colorize('user>', ANSI_DIM, options.colorEnabled)} `);
  let firstSend = true;
  let stop: () => void = () => {};
  let exitContinuity = false;
  let inputEnded = false;
  let pendingReconnects = 0;
  let promptVisible = false;
  let terminalClosed = false;
  let shownHoldStatus = formatReportHoldStatus(options.dispatchQueue);
  const stopping = new Promise<void>((resolve) => {
    stop = resolve;
  });
  const requestStop = (exitCode?: number) => {
    if (exitCode !== undefined) process.exitCode = exitCode;
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
        options.dispatchQueue.setConversationHold(true);
        options.dispatchQueue.enqueueUser(message);
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
        try {
          await reconnectConductorAgent(options.agentHandle, {
            conductorAgentFactory: options.agentHandle.factory,
            conductorOptions: options.agentHandle.agentOptions,
          });
          writeChannelLine('observation', 'conductor に再接続しました。');
        } catch {
          writeChannelLine('harness', 'conductor の再接続に失敗しました。', {
            color: ANSI_RED,
          });
        }
        continue;
      }
      const batch = options.dispatchQueue.takeBatch(dispatchState);
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
      const prompt =
        options.backend === 'cursor' && firstSend
          ? `${options.systemPrompt}\n\n## User message\n\n${formatOperatorDispatchBatch(batch.events)}`
          : formatOperatorDispatchBatch(batch.events);
      const result = await Promise.race([
        sendConductorWithReconnect(
          options.agentHandle,
          prompt,
          {
            conductorAgentFactory: options.agentHandle.factory,
            conductorOptions: options.agentHandle.agentOptions,
          },
        ),
        stopping.then(() => undefined),
      ]);
      if (!result) return exitContinuity;
      firstSend = false;
      dispatchState.lastDispatchedSourceKey = batch.sourceKey;
      dispatchState.continuationConsumed = batch.usedContinuation;
      const sendCompleted =
        result.status === 'finished' || result.status === 'completed';
      if (sendCompleted) {
        await options.watchPool.acknowledge(batch.events);
      } else {
        for (const event of batch.events) {
          if (event.type === 'report') options.dispatchQueue.requeue(event, 5_000);
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
                    '認証設定を直した後に `ensemble operator-agent` を再起動してください。',
                },
              )}\n`,
            );
          }
        } else {
          writeChannelLine(
            'harness',
            `send not completed (status=${result.status}); watched reports retained for retry.`,
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
        writeChannelLine('observation', `completed (status: ${result.status}).`);
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
