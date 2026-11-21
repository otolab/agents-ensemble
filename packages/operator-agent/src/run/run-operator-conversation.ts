import { createOperatorWaiters } from './run-operator-waiters.js';
import { createOperatorStatus } from './run-operator-status.js';
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
import { createOperatorIdleCandidateMonitor, isOperatorIdleGateActive } from '../dispatch/operator-idle-candidates.js';

import type { RunOperatorAgentOptions, OperatorAgentInput, OperatorAgentOutput, RunOperatorAgentDependencies, OperatorRuntime, OperatorAgentHandle, OperatorAgentDispatchPayload, OperatorTtyChannels, OperatorPiActivityEvent, OperatorPiActivity, OperatorTtyLogEntry, OperatorTtyLogRouter } from './run-operator-agent-types.js';

export async function runTtyConversation(options: {
  agentHandle: OperatorAgentHandle;
  backend: ConductorBackend;
  systemPrompt: string;
  stdin: OperatorAgentInput;
  stdout: OperatorAgentOutput;
  stderr: OperatorAgentOutput;
  ttyLogRouter: OperatorTtyLogRouter;
  piActivity: OperatorPiActivity;
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
  const inputEnding = new AbortController();
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
  const status = createOperatorStatus(tui, sendSuppression.signal, () => agentSendInFlight);
  const setStatus = status.setStatus;
  options.piActivity.listener = status.listener;
  const unsubscribeTtyLogRouter = options.ttyLogRouter.attach((entry) => {
    tui.appendChannel(entry.channel, entry.detail, entry.options);
  });
  const writeChannelLine = (
    channel: keyof OperatorTtyChannels,
    detail: string,
    displayOptions: OperatorAgentTuiLogOptions = {},
  ) => tui.appendChannel(channel, detail, displayOptions);
  const { waitForAcknowledgementRetry, retryWatchLock } = createOperatorWaiters(
    sendSuppression, inputEnding, () => inputEnded, writeChannelLine,
  );
  tui.setHarnessStatus(shownHoldStatus);
  const unsubscribeHoldChanges = options.dispatchQueue.subscribe(() => {
    const nextStatus = formatReportHoldStatus(options.dispatchQueue);
    if (nextStatus === shownHoldStatus) return;
    shownHoldStatus = nextStatus;
    tui.setHarnessStatus(nextStatus);
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
    continueAfterRecoveryForAttempt: (expectedAttemptId: string) =>
      options.dispatchLifecycle.confirmRecovery(expectedAttemptId),
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
    inputEnding.abort();
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
      inputEnding.abort();
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
        if (isOperatorIdleGateActive(options.dispatchQueue, () => agentSendInFlight)) {
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
        setStatus('reconnecting');
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
        status.clearActivity();
        setStatus('待機中');
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
      // Use the same clock reading for selection and the next deadline. A
      // deadline crossing between those operations must still wake this loop.
      const selectionTime = Date.now();
      const batch = options.dispatchQueue.selectBatch(dispatchState, selectionTime);
      if (!batch) {
        const readyAt = options.dispatchQueue.nextReadyAt(selectionTime);
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
      const deliveryKind = batch.batchId ? 'frozen_replay' : 'initial';
      try {
        const result = await retryWatchLock(
          () => options.watchPool.commitBatch(batch, dispatchState),
          '送信準備',
        );
        if (result.stopped) {
          agentSendInFlight = false;
          idleCandidateMonitor.notifyActivityChanged();
          if (reservation) options.recoveryInbox.release(reservation);
          options.dispatchLifecycle.settleSend(lease, { completed: true });
          return exitContinuity;
        }
        committed = result.value;
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
      setStatus('処理中');
      writeChannelLine('harness', 'operator: 処理中');
      const nextSendCount = sendCount + 1;
      let toolCallStarted = false;
      let acceptingActivity = true;
      const activeTools = new Map<string, { tool: string; since: number }>();
      const showActiveTool = () => {
        const active = Array.from(activeTools.values()).at(-1);
        if (active) setStatus(`calling ${active.tool}`, active.since);
        else setStatus('処理中');
      };
      automaticReconnectResult.current = undefined;
      let result: ConductorSendResult | undefined;
      const sendStartedAt = Date.now();
      // Snapshot without expiring focus or recording events in the synchronous
      // commit-to-send section; the snapshot belongs to this send attempt.
      let focusState: 'focused_session' | 'other_session' | 'off' | 'unknown' = 'unknown';
      try {
        const focused = options.dispatchQueue.focusSessionIdAt(sendStartedAt);
        if (batch.sourceKey.startsWith('session:') && batch.sourceKey.length > 'session:'.length) {
          focusState = !focused ? 'off' : batch.sourceKey === `session:${focused}` ? 'focused_session' : 'other_session';
        }
      } catch { /* missing diagnostic state must not block delivery */ }
      try {
        result = await Promise.race([
          sendConductorWithReconnect(
            options.agentHandle,
            prompt,
            {
              conductorAgentFactory: options.agentHandle.factory,
              conductorOptions: options.agentHandle.agentOptions,
              signal: sendSuppression.signal,
              history: { sendCount: nextSendCount, dispatchSource: batch.sourceKey },
              onOutputPhase: (phase) => {
                if (acceptingActivity && activeTools.size === 0) setStatus(phase);
              },
              onToolCallStarted: ({ tool, callId }) => {
                if (!acceptingActivity) return;
                activeTools.delete(callId);
                activeTools.set(callId, { tool: formatOperatorToolName(tool), since: Date.now() });
                showActiveTool();
                toolCallStarted = true;
                writeChannelLine(
                  'harness',
                  `operator: calling ${formatOperatorToolName(tool)}`,
                );
              },
              onToolCallCompleted: ({ callId }) => {
                if (!acceptingActivity || !activeTools.has(callId)) return;
                const displayed = Array.from(activeTools.keys()).at(-1) === callId;
                activeTools.delete(callId);
                if (displayed) showActiveTool();
              },
              onAuthReconnectAttempt: ({ agentId, source }) => {
                acceptingActivity = false;
                setStatus('reconnecting');
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
                acceptingActivity = false;
                setStatus('reconnecting');
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
        acceptingActivity = false;
        status.clearActivity();
        setStatus('待機中');
        agentSendInFlight = false;
        idleCandidateMonitor.notifyActivityChanged();
      }
      if (batch.batchId) {
        const completedAt = Date.now();
        options.watchPool.recordSchedulingEvent?.({
          type: 'batch.sent', ts: completedAt, batchId: batch.batchId,
          sendCount: nextSendCount, status: result?.status ?? 'interrupted',
          startedAt: sendStartedAt, completedAt, deliveryKind, focusState,
        });
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
        if (batch.sourceKey.startsWith('session:')) {
          options.dispatchQueue.completeReportRequest(batch.events);
        }
      } else {
        const retryReadyAt = Date.now() + 5_000;
        const retryRecord = await retryWatchLock(
          async () => options.watchPool.recordRetry?.(batch.events, retryReadyAt),
          '再送時刻の保存',
          true,
        );
        if (retryRecord.stopped) return exitContinuity;
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
    options.piActivity.listener = undefined;
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
