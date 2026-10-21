import { createInterface } from 'node:readline';
import { resolve } from 'node:path';
import { compile, merge } from '@modular-prompt/core';
import {
  createConductorAgentFactory,
  filterMaterialsForKind,
  isOperatorCommand,
  loadEnsembleConfig,
  loadProfile,
  profilePromptModule,
  renderCompiledPrompt,
  resolveAgentPromptModule,
  resolveConductorBackendSetting,
  resolveConductorModelId,
  resolveConductorPiResourcePaths,
  sessionStateFromProfile,
  type ConductorAgent,
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
  createRegisterSessionWatchTool,
  createUnregisterSessionWatchTool,
  type OperatorWatchPool,
} from './operator-watch-pool.js';
import {
  createAnswerLiveOpenQuestionTool,
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
  assertTty(stdin, stdout);

  const runtime = await resolveOperatorRuntime(options, dependencies);
  const factory =
    dependencies.agentFactory ?? createConductorAgentFactory(runtime.backend);
  const dispatchQueue = createOperatorDispatchQueue();
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
      stdout.write(`operator-agent watch warning: ${message}\n`),
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
          piSkills: runtime.profile.conductor?.piSkills !== false,
          piExtensions: false,
        }
      : {}),
    customTools: {
      list_operator_sessions: createListOperatorSessionsTool(runtime.repoRoot),
      list_live_open_questions: createListLiveOpenQuestionsTool(runtime.repoRoot),
      answer_live_open_question: createAnswerLiveOpenQuestionTool(runtime.repoRoot),
      register_session_watch: createRegisterSessionWatchTool(watchPool),
      unregister_session_watch: createUnregisterSessionWatchTool(watchPool),
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

  try {
    await saveOperatorAgentState(runtime.repoRoot, {
      version: 1,
      agentId: agent.agentId,
      backend: runtime.backend,
      repoRoot: runtime.repoRoot,
    });
    const exitContinuity = await runTtyConversation({
      agent,
      backend: runtime.backend,
      systemPrompt: runtime.systemPrompt,
      stdin,
      stdout,
      dispatchQueue,
      watchPool,
      colorEnabled:
        Boolean(stdin.isTTY && stdout.isTTY) && process.env.NO_COLOR === undefined,
    });
    if (exitContinuity) {
      await clearOperatorAgentState(runtime.repoRoot);
    }
  } finally {
    watchPool.close();
    await agent.close();
  }
}

async function resolveOperatorRuntime(
  options: RunOperatorAgentOptions,
  dependencies: RunOperatorAgentDependencies,
): Promise<OperatorRuntime> {
  const repoRoot = resolve(options.repoRoot ?? process.cwd());
  const config = await (dependencies.loadConfig ?? loadEnsembleConfig)(repoRoot);
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
  agent: ConductorAgent;
  backend: ConductorBackend;
  systemPrompt: string;
  stdin: OperatorAgentInput;
  stdout: OperatorAgentOutput;
  dispatchQueue: ReturnType<typeof createOperatorDispatchQueue>;
  watchPool: OperatorWatchPool;
  colorEnabled: boolean;
}): Promise<boolean> {
  const terminal = createInterface({
    input: options.stdin,
    output: options.stdout,
    terminal: true,
    crlfDelay: Infinity,
  });
  let firstSend = true;
  let stop: () => void = () => {};
  let exitContinuity = false;
  let inputEnded = false;
  const stopping = new Promise<void>((resolve) => {
    stop = resolve;
  });
  const requestStop = (exitCode?: number) => {
    if (exitCode !== undefined) process.exitCode = exitCode;
    terminal.close();
    stop();
  };
  const handleInterrupt = () => requestStop(130);
  const handleTermination = () => requestStop(143);
  terminal.on('SIGINT', handleInterrupt);
  process.on('SIGINT', handleInterrupt);
  process.on('SIGTERM', handleTermination);
  writeStatusLine(
    options.stdout,
    'operator-agent',
    `(${options.backend}) ready — enter /exit to start a fresh session next time.`,
    options.colorEnabled,
    { leadingBlank: false },
  );

  const readInput = async () => {
    try {
      for await (const rawLine of terminal) {
        const message = rawLine.trim();
        if (!message) continue;
        if (isOperatorCommand(message, 'exit')) {
          exitContinuity = true;
          writeStatusLine(
            options.stdout,
            'operator-agent',
            'session ended.',
            options.colorEnabled,
          );
          terminal.close();
          break;
        }
        options.dispatchQueue.enqueueUser(message);
      }
    } finally {
      inputEnded = true;
      options.dispatchQueue.wake();
    }
  };
  const inputTask = readInput();
  const dispatchState: OperatorDispatchState = {
    continuationConsumed: false,
  };
  let promptVisible = false;
  let shownHeldCount = -1;
  let shownHold = false;

  try {
    while (true) {
      if (inputEnded && options.dispatchQueue.pendingUserCount === 0) {
        return exitContinuity;
      }
      if (
        promptVisible &&
        (shownHeldCount !== options.dispatchQueue.heldEventCount ||
          shownHold !== options.dispatchQueue.hold)
      ) {
        options.stdout.write('\n');
        promptVisible = false;
      }
      if (!promptVisible) {
        if (options.dispatchQueue.hold || options.dispatchQueue.heldEventCount > 0) {
          options.stdout.write(
            `報告保留中（${options.dispatchQueue.heldEventCount} 件）\n`,
          );
        }
        options.stdout.write(
          `${colorize('user>', ANSI_DIM, options.colorEnabled)} `,
        );
        promptVisible = true;
        shownHeldCount = options.dispatchQueue.heldEventCount;
        shownHold = options.dispatchQueue.hold;
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
      promptVisible = false;
      const prompt =
        options.backend === 'cursor' && firstSend
          ? `${options.systemPrompt}\n\n## User message\n\n${formatOperatorDispatchBatch(batch.events)}`
          : formatOperatorDispatchBatch(batch.events);
      const result = await Promise.race([
        options.agent.send(prompt),
        stopping.then(() => undefined),
      ]);
      if (!result) return exitContinuity;
      firstSend = false;
      dispatchState.lastDispatchedSourceKey = batch.sourceKey;
      dispatchState.continuationConsumed = batch.usedContinuation;
      if (result.status === 'error') {
        for (const event of batch.events) {
          if (event.type === 'report') options.dispatchQueue.requeue(event, 5_000);
        }
        writeStatusLine(
          options.stdout,
          'operator-agent error:',
          result.error?.message ?? result.result ?? 'request failed',
          options.colorEnabled,
          { color: ANSI_RED },
        );
      } else {
        await options.watchPool.acknowledge(batch.events);
      }
      if (result.status !== 'error' && result.result?.trim()) {
        const response = normalizeOperatorResponse(result.result);
        options.stdout.write(
          `\n${colorize('operator>', ANSI_CYAN, options.colorEnabled)}\n${response}\n\n`,
        );
      } else if (result.status !== 'error') {
        writeStatusLine(
          options.stdout,
          'operator-agent',
          `completed (status: ${result.status}).`,
          options.colorEnabled,
        );
      }
    }
  } finally {
    await inputTask.catch(() => {});
    terminal.off('SIGINT', handleInterrupt);
    process.off('SIGINT', handleInterrupt);
    process.off('SIGTERM', handleTermination);
    terminal.close();
  }
}

function normalizeOperatorResponse(response: string): string {
  return response.trim().replace(/\r\n?/g, '\n').replace(/\n{3,}/g, '\n\n');
}

function writeStatusLine(
  output: OperatorAgentOutput,
  label: string,
  detail: string,
  colorEnabled: boolean,
  displayOptions: { color?: string; leadingBlank?: boolean } = {},
): void {
  const leadingBlank = displayOptions.leadingBlank === false ? '' : '\n';
  const color = displayOptions.color ?? ANSI_DIM;
  output.write(`${leadingBlank}${colorize(label, color, colorEnabled)} ${detail}\n\n`);
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
