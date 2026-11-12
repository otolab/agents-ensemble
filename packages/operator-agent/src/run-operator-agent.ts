import { clearLine, createInterface, cursorTo } from 'node:readline';
import { resolve } from 'node:path';
import { compile, merge } from '@modular-prompt/core';
import {
  createConductorAgentFactory,
  ConductorDispatchLifecycle,
  ConductorRecoveryInbox,
  executeRecoveryInboxCommand,
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
  resolveConductorReasoning,
  resolveEnsemblePaths,
  settleConductorDispatch,
  sendConductorWithReconnect,
  sessionStateFromProfile,
  type ConductorAgent,
  type ConductorAgentCreateOptions,
  type ConductorAgentHandle,
  type ConductorAgentFactory,
  type ConductorBackend,
  type ConductorRecoveryReconnect,
  type ConductorSendResult,
  type EnsembleConfig,
  type ResolvedProfile,
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
  reasoning?: string;
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

  const runtime = await resolveOperatorRuntime(options, dependencies);
  const factory =
    dependencies.agentFactory ?? createConductorAgentFactory(runtime.backend);
  const dispatchQueue = createOperatorDispatchQueue();
  const ttyChannels: OperatorTtyChannels = {
    harness: (detail) => stdout.write(`\n[harness] ${detail}\n\n`),
    observation: (detail) => stdout.write(`\n[observation] ${detail}\n\n`),
  };
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
    ...(runtime.reasoning !== undefined
      ? { reasoning: runtime.reasoning }
      : {}),
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
        reportResumeStoreDuplicate,
      ),
      list_live_open_questions: createListLiveOpenQuestionsTool(
        runtime.repoRoot,
        reportResumeStoreDuplicate,
      ),
      answer_live_open_question: createAnswerLiveOpenQuestionTool(
        runtime.repoRoot,
        reportResumeStoreDuplicate,
      ),
      get_last_conductor_message: createGetLastConductorMessageTool(
        runtime.repoRoot,
        reportResumeStoreDuplicate,
      ),
      list_conductor_messages: createListConductorMessagesTool(
        runtime.repoRoot,
        reportResumeStoreDuplicate,
      ),
      register_session_watch: createRegisterSessionWatchTool(watchPool),
      unregister_session_watch: createUnregisterSessionWatchTool(watchPool),
      register_conductor_message_listen:
        createRegisterConductorMessageListenTool(watchPool),
      unregister_conductor_message_listen:
        createUnregisterConductorMessageListenTool(watchPool),
      set_report_hold: createSetReportHoldTool(dispatchQueue),
      release_reports: createReleaseReportsTool(dispatchQueue),
      send_operator_message: createSendOperatorMessageTool(
        runtime.repoRoot,
        reportResumeStoreDuplicate,
      ),
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
  const recoveryInbox = new ConductorRecoveryInbox();
  const dispatchLifecycle =
    new ConductorDispatchLifecycle<OperatorAgentDispatchPayload>();
  const operatorCanInspectRecovery = Boolean(
    stdin.isTTY && stdout.isTTY && stderr.isTTY,
  );
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
      recoveryInbox,
      dispatchLifecycle,
      operatorCanInspectRecovery,
      colorEnabled:
        Boolean(stdin.isTTY && stdout.isTTY) && process.env.NO_COLOR === undefined,
    });
    if (exitContinuity) {
      await clearOperatorAgentState(runtime.repoRoot);
    }
  } finally {
    recoveryInbox.dispose();
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
  const reasoning = resolveConductorReasoning(undefined, { config });
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

  return {
    repoRoot,
    config,
    profile,
    backend,
    modelId,
    ...(reasoning !== undefined ? { reasoning } : {}),
    systemPrompt,
  };
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
  let firstSend = true;
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
            onReconnectAttempt: ({ agentId, source }) => {
              writeChannelLine(
                'harness',
                `conductor の再接続を開始します。agentId=${agentId} source=${source} failure=${failureClass}`,
              );
            },
            onReconnectComplete: ({ agentId, success, source }) => {
              reconnectReported = true;
              writeChannelLine(
                success ? 'observation' : 'harness',
                `${success ? 'conductor に再接続しました。' : 'conductor の再接続に失敗しました。'}agentId=${agentId} source=${source} failure=${failureClass}`,
                success ? {} : { color: ANSI_RED },
              );
            },
          });
          options.dispatchLifecycle.settleReconnect(reconnectLease, true);
        } catch {
          options.dispatchLifecycle.settleReconnect(reconnectLease, false);
          if (!reconnectReported) {
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
        options.backend === 'cursor' && firstSend
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
            onAuthReconnectComplete: ({ success, source }) => {
              options.dispatchLifecycle.setAgentAvailable(success);
              automaticReconnectResult.current = {
                reason: 'auth',
                succeeded: success,
              };
              writeChannelLine(
                success ? 'observation' : 'harness',
                `[auth] conductor reconnect ${success ? 'succeeded' : 'failed'} source=${source ?? 'automatic'}`,
                success ? {} : { color: ANSI_RED },
              );
            },
            onTransportReconnectAttempt: ({ agentId, source }) => {
              writeChannelLine(
                'harness',
                `[transport] conductor reconnect attempt agentId=${agentId} source=${source ?? 'automatic'}`,
              );
            },
            onTransportReconnectComplete: ({ success, source }) => {
              options.dispatchLifecycle.setAgentAvailable(success);
              automaticReconnectResult.current = {
                reason: 'transport',
                succeeded: success,
              };
              writeChannelLine(
                success ? 'observation' : 'harness',
                `[transport] conductor reconnect ${success ? 'succeeded' : 'failed'} source=${source ?? 'automatic'}`,
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
      firstSend = false;
      dispatchState.lastDispatchedSourceKey = batch.sourceKey;
      dispatchState.continuationConsumed = batch.usedContinuation;
      const sendCompleted =
        result.status === 'finished' || result.status === 'completed';
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
            `operator send が未完了です (status=${result.status}, failure=${settled.failureClass ?? 'unknown'})。失敗した入力は queue に戻していません。${recoveryDetails}`,
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
