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
import { createListOperatorSessionsTool } from './list-operator-sessions-tool.js';
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
      send_operator_message: createSendOperatorMessageTool(runtime.repoRoot),
    },
  };
  const agent = existingState
    ? await factory.resume(existingState.agentId, agentOptions)
    : await factory.create(agentOptions);

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
    });
    if (exitContinuity) {
      await clearOperatorAgentState(runtime.repoRoot);
    }
  } finally {
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
}): Promise<boolean> {
  const terminal = createInterface({
    input: options.stdin,
    output: options.stdout,
    terminal: true,
    crlfDelay: Infinity,
  });
  const input = terminal[Symbol.asyncIterator]();
  let firstSend = true;
  let stop: () => void = () => {};
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
  options.stdout.write(
    `operator-agent (${options.backend}) ready — enter /exit to start a fresh session next time.\n`,
  );

  try {
    while (true) {
      options.stdout.write('user> ');
      const next = await Promise.race([
        input.next(),
        stopping.then(() => ({ done: true as const, value: undefined })),
      ]);
      if (next.done) return false;
      const message = next.value.trim();
      if (!message) continue;
      if (isOperatorCommand(message, 'exit')) {
        options.stdout.write('operator-agent session ended.\n');
        return true;
      }

      const prompt =
        options.backend === 'cursor' && firstSend
          ? `${options.systemPrompt}\n\n## User message\n\n${message}`
          : message;
      const result = await Promise.race([
        options.agent.send(prompt),
        stopping.then(() => undefined),
      ]);
      if (!result) return false;
      firstSend = false;
      if (result.status === 'error') {
        options.stdout.write(
          `operator-agent error: ${result.error?.message ?? result.result ?? 'request failed'}\n`,
        );
      } else if (result.result?.trim()) {
        options.stdout.write(`operator> ${result.result.trim()}\n`);
      } else {
        options.stdout.write(`operator-agent completed (status: ${result.status}).\n`);
      }
    }
  } finally {
    terminal.off('SIGINT', handleInterrupt);
    process.off('SIGINT', handleInterrupt);
    process.off('SIGTERM', handleTermination);
    terminal.close();
  }
}

function assertTty(stdin: OperatorAgentInput, stdout: OperatorAgentOutput): void {
  if (!stdin.isTTY || !stdout.isTTY) {
    throw new Error(
      'ensemble operator-agent requires an interactive TTY on stdin and stdout.',
    );
  }
}
