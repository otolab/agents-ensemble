import { resolveOperatorRuntime, addOperatorMcpStartupContext, selectSavedConversation } from './run/run-operator-bootstrap.js';
import { runTtyConversation } from './run/run-operator-conversation.js';
import type { RunOperatorAgentOptions, OperatorAgentInput, OperatorAgentOutput, RunOperatorAgentDependencies, OperatorRuntime, OperatorAgentHandle, OperatorAgentDispatchPayload, OperatorTtyChannels, OperatorPiActivityEvent, OperatorPiActivity, OperatorTtyLogEntry, OperatorTtyLogRouter } from './run/run-operator-agent-types.js';
export type { RunOperatorAgentOptions, RunOperatorAgentDependencies, OperatorAgentInput, OperatorAgentOutput } from './run/run-operator-agent-types.js';

import { ANSI_RED } from './internal/operator-utils.js';
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
import { operatorBaseModule } from './run/operator-base-module.js';
import { OperatorLockTimeoutError, withOperatorWorkspaceLock } from './workspace/operator-workspace-lock.js';
import {
  createOperatorDispatchQueue,
  formatOperatorDispatchBatch,
  type OperatorDispatchBatch,
  type OperatorDispatchState,
} from './dispatch/operator-dispatch.js';
import {
  OPERATOR_WATCH_ACK_MAX_RETRIES,
  OPERATOR_WATCH_ACK_RETRY_DELAY_MS,
  retryOperatorWatchAcknowledgement,
} from './watch/operator-watch-ack.js';
import { createListOperatorSessionsTool } from './tools/list-operator-sessions-tool.js';
import {
  createReleaseReportsTool,
  createSetReportHoldTool,
  createSetSessionFocusTool,
  createRequestSessionReportsTool,
  createListPendingReportsTool,
} from './tools/operator-control-tools.js';
import {
  createOperatorWatchPool,
  createRegisterConductorMessageListenTool,
  createRegisterRepositoryWatchTool,
  createRegisterSessionWatchTool,
  createUnregisterConductorMessageListenTool,
  createUnregisterRepositoryWatchTool,
  createUnregisterSessionWatchTool,
  type OperatorWatchPool,
} from './watch/operator-watch-pool.js';
import {
  createAnswerLiveOpenQuestionTool,
  createGetLastConductorMessageTool,
  createListConductorMessagesTool,
  createListLiveOpenQuestionsTool,
  createSendOperatorMessageTool,
  createShutdownIssueSessionTool,
} from './tools/open-question-control-tools.js';
import { createListWorkerMessagesTool } from './tools/worker-session-tools.js';
import {
  createOperatorWorkspaceFileTools,
  assertNoMoveJournal,
  workspaceMoveJournalPath,
  resolveOperatorWorkspaceRoot,
} from './workspace/operator-workspace-tools.js';
import {
  listOperatorAgentStates,
  loadOperatorAgentState,
  saveOperatorAgentState,
  clearOperatorAgentState,
  operatorPiSessionDirectory,
  type OperatorAgentState,
} from './run/operator-agent-state.js';
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
} from './config/operator-agent-config.js';
import { resolveOperatorAgentMcpServers } from './config/operator-agent-mcp.js';
import {
  createOperatorAgentTuiHost,
  type OperatorAgentTuiLogOptions,
} from './tui/operator-agent-tui.js';
import { createOperatorIdleCandidateMonitor } from './dispatch/operator-idle-candidates.js';

























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
  let watchPoolForEvents: OperatorWatchPool | undefined;
  const dispatchQueue = createOperatorDispatchQueue({
    batchMaxWaitMs: runtime.scheduling.batchMaxWaitMs,
    idleAgingMs: runtime.scheduling.idleAgingMs,
    focusInactivityTimeoutMs: runtime.scheduling.focusInactivityTimeoutMs,
    pushThreshold: runtime.scheduling.pushThreshold,
    reportWeights: {
      session_state: runtime.scheduling.sessionStateWeight,
      open_question: runtime.scheduling.openQuestionWeight,
      conductor_message: runtime.scheduling.conductorMessageWeight,
      idle_candidate: runtime.scheduling.idleCandidateWeight,
    },
  }, undefined, (event) => watchPoolForEvents?.recordSchedulingEvent?.(event));
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
    autoDiscoverSessions: dependencies.autoDiscoverSessions ?? true,
    userEnsembleRoot: runtime.userEnsembleRoot,
    profile: runtime.profileName,
    profileIncludes: runtime.profile.include,
    repoFilters: runtime.repoFilters,
    dispatchQueue,
    onError: (message) =>
      ttyChannels.harness(`watch warning: ${message}`),
  });
  watchPoolForEvents = watchPool;

  const piActivity: OperatorPiActivity = {};
  let compactionCount = 0;
  const agentOptions: ConductorAgentCreateOptions = {
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
          onRetryEvent: (event: Parameters<NonNullable<ConductorAgentCreateOptions['onRetryEvent']>>[0]) => {
            piActivity.listener?.({ kind: 'retry', value: event });
            switch (event.type) {
              case 'auto_retry_start':
                ttyChannels.harness(`[pi retry] attempt ${event.attempt}/${event.maxAttempts} in ${event.delayMs}ms error=${escapeTerminalControlCharacters(event.errorMessage)}`);
                break;
              case 'auto_retry_end':
                ttyChannels.harness(`[pi retry] ${event.success ? 'succeeded' : 'failed'} attempt=${event.attempt}${event.finalError ? ` error=${escapeTerminalControlCharacters(event.finalError)}` : ''}`);
                break;
              case 'summarization_retry_scheduled':
                ttyChannels.harness(`[pi summarization retry] attempt ${event.attempt}/${event.maxAttempts} in ${event.delayMs}ms error=${escapeTerminalControlCharacters(event.errorMessage)}`);
                break;
              case 'summarization_retry_attempt_start':
                ttyChannels.harness(`[pi summarization retry] attempt started source=${event.source}${event.reason ? ` reason=${event.reason}` : ''}`);
                break;
              case 'summarization_retry_finished':
                ttyChannels.harness('[pi summarization retry] finished');
                break;
            }
          },
          pi: runtime.piResourceRoots,
          sessionDir: operatorPiSessionDirectory(
            runtime.userEnsembleRoot,
            operatorAgentId,
          ),
          piSkills: runtime.profile.pi?.skills !== false,
          piExtensions: false,
          operatorPiMcpMode: 'direct' as const,
          onCompactionEvent: (event) => {
            piActivity.listener?.({ kind: 'compaction', value: event });
            const reason = { manual: '手動', threshold: '自動', overflow: 'context 超過' }[event.reason];
            if (event.type === 'start') {
              ttyChannels.harness(`operator: compaction 開始（${reason}）`);
            } else if (event.outcome === 'success') {
              compactionCount += 1;
              const tokens = event.tokensBefore === undefined ? '' : `、圧縮前 ${event.tokensBefore} tokens`;
              ttyChannels.harness(`operator: compaction 成功（このプロセスで ${compactionCount} 回${tokens}）`);
            } else if (event.outcome === 'aborted') {
              ttyChannels.harness('operator: compaction 中断');
            } else {
              const error = escapeTerminalControlCharacters(event.errorMessage ?? '詳細不明');
              ttyChannels.harness(`operator: compaction 失敗: ${error}`);
            }
          },
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
      request_session_reports: createRequestSessionReportsTool(dispatchQueue),
      list_pending_reports: createListPendingReportsTool(dispatchQueue),
      set_session_focus: createSetSessionFocusTool(dispatchQueue),
      send_operator_message: createSendOperatorMessageTool(
        { userEnsembleRoot: runtime.userEnsembleRoot },
        reportResumeStoreDuplicate,
        (id) => watchPool.ensureConductorMessageListen(id),
        (message) => ttyChannels.observation(message),
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
      piActivity,
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
    await watchPool.flushSchedulingEvents?.();
    await closeConductorAgentOnce(agentHandle.conductor);
  }
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







function assertTty(stdin: OperatorAgentInput, stdout: OperatorAgentOutput): void {
  if (!stdin.isTTY || !stdout.isTTY) {
    throw new Error(
      'ensemble operator-agent requires an interactive TTY on stdin and stdout.',
    );
  }
}
