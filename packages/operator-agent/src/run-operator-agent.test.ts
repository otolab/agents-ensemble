import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';
import { tmpdir } from 'node:os';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type {
  ConductorAgent,
  ConductorAgentCreateOptions,
  ConductorAgentFactory,
  EnsembleConfig,
  ResolvedProfile,
} from '@agents-ensemble/core/operator-runtime';
import {
  runOperatorAgent,
  type OperatorAgentInput,
  type OperatorAgentOutput,
} from './run-operator-agent.js';

describe('runOperatorAgent', () => {
  let repoRoot = '';
  let originalModelEnv: string | undefined;
  let originalProfileEnv: string | undefined;

  beforeEach(async () => {
    repoRoot = await mkdtemp(join(tmpdir(), 'ensemble-operator-agent-'));
    originalModelEnv = process.env.CONDUCTOR_MODEL_ID;
    originalProfileEnv = process.env.ENSEMBLE_DEFAULT_PROFILE;
    delete process.env.CONDUCTOR_MODEL_ID;
    delete process.env.ENSEMBLE_DEFAULT_PROFILE;
    await mkdir(join(repoRoot, '.ensemble', 'teams', 'smoke'), { recursive: true });
    await mkdir(join(repoRoot, '.ensemble', 'sessions'), { recursive: true });
    await writeFile(
      join(repoRoot, '.ensemble', 'config.yaml'),
      [
        'profile:',
        '  default: smoke',
        'conductor:',
        '  backend: pi',
        '  model: smoke-model',
        '  pi:',
        '    agentDir: .ensemble/pi-user',
        '    projectDir: .ensemble/pi-project',
        '',
      ].join('\n'),
    );
    await writeFile(
      join(repoRoot, '.ensemble', 'teams', 'smoke', 'profile.yaml'),
      [
        'meta:',
        '  title: Operator smoke profile',
        'agents:',
        '  operator:',
        '    prompt:',
        '      instructions:',
        '        - Profile operator guidance.',
        'workers:',
        '  - name: implementer',
        '    kind: implementer',
        '',
      ].join('\n'),
    );
    await writeFile(
      join(repoRoot, '.ensemble', 'sessions', 'conductor-one.json'),
      JSON.stringify({
        version: 1,
        conductorAgentId: 'conductor-one',
        conductorBackend: 'pi',
        issueUrl: 'https://github.com/example/project/issues/12',
        repoRoot,
        profile: { workers: [], agents: {} },
        openQuestions: [
          {
            id: 'inq-1',
            question: 'Approve this operation?',
            responseType: 'yes_no',
            source: 'conductor',
            status: 'open',
            askedAt: 1,
            relatedPermissionId: 'permission-1',
          },
        ],
        sequence: 1,
        workers: { implementer: { acpSessionId: 'worker-one' } },
        updatedAt: 100,
      }),
    );
  });

  afterEach(async () => {
    if (originalModelEnv === undefined) {
      delete process.env.CONDUCTOR_MODEL_ID;
    } else {
      process.env.CONDUCTOR_MODEL_ID = originalModelEnv;
    }
    if (originalProfileEnv === undefined) {
      delete process.env.ENSEMBLE_DEFAULT_PROFILE;
    } else {
      process.env.ENSEMBLE_DEFAULT_PROFILE = originalProfileEnv;
    }
    await rm(repoRoot, { recursive: true, force: true });
  });

  it('requires both terminal streams before loading config or starting an agent', async () => {
    const loadConfig = vi.fn();
    const input = createInput('hello\n', false);
    const output = createOutput();

    await expect(
      runOperatorAgent(
        { repoRoot },
        { stdin: input, stdout: output, loadConfig },
      ),
    ).rejects.toThrow('requires an interactive TTY');
    expect(loadConfig).not.toHaveBeenCalled();
  });

  it('runs a Pi-backed TTY conversation with profile prompt and saved session summaries', async () => {
    const input = createInput('状況を教えて\n/exit\n');
    const output = createOutput();
    let agentOptions: ConductorAgentCreateOptions | undefined;
    const sentPrompts: string[] = [];
    const fakeAgent = createFakeAgent({
      send: async (prompt) => {
        sentPrompts.push(prompt);
        const tool = agentOptions?.customTools?.list_operator_sessions;
        expect(tool).toBeDefined();
        const toolResult = await tool!.execute({ limit: 1 });
        expect(toolResult.content[0]?.text).toContain(
          'https://github.com/example/project/issues/12',
        );
        expect(toolResult.content[0]?.text).toContain('permission-1');
        return {
          runId: 'run-1',
          status: 'completed',
          result: '保存済み sidecar では implementer のセッションが確認できます。',
        };
      },
    });
    const agentFactory: ConductorAgentFactory = {
      create: async (options) => {
        agentOptions = options;
        return fakeAgent;
      },
      resume: async () => {
        throw new Error('operator-agent sessions are always new');
      },
    };

    await runOperatorAgent({ repoRoot }, { stdin: input, stdout: output, agentFactory });

    const transcript = output.capturedText();
    expect(sentPrompts).toEqual(['状況を教えて']);
    expect(transcript).toContain('operator-agent (pi) ready');
    expect(transcript).toContain('保存済み sidecar では implementer');
    expect(transcript).toContain('operator-agent session ended.');
    expect(agentOptions).toMatchObject({
      cwd: repoRoot,
      modelId: 'smoke-model',
      builtinTools: false,
      pi: {
        agentDir: join(repoRoot, '.ensemble', 'pi-user'),
        projectDir: join(repoRoot, '.ensemble', 'pi-project'),
      },
      piExtensions: false,
    });
    expect(agentOptions?.systemPrompt).toContain('operator ロール');
    expect(agentOptions?.systemPrompt).toContain('Profile operator guidance.');
    expect(agentOptions?.systemPrompt).not.toContain('dispatch');
    expect(Object.keys(agentOptions?.customTools ?? {})).toEqual([
      'list_operator_sessions',
    ]);
  });

  it('adds the operator prompt to the first Cursor SDK turn', async () => {
    const input = createInput('hello\n/exit\n');
    const output = createOutput();
    const config: EnsembleConfig = {
      profile: { default: 'unused' },
      conductor: { backend: 'cursor', model: 'cursor-model' },
    } as EnsembleConfig;
    const profile: ResolvedProfile = {
      workers: [],
      agents: {},
    };
    const sentPrompts: string[] = [];
    const fakeAgent = createFakeAgent({
      send: async (prompt) => {
        sentPrompts.push(prompt);
        return { runId: 'run-1', status: 'completed', result: 'Hello from operator.' };
      },
    });

    await runOperatorAgent(
      { repoRoot },
      {
        stdin: input,
        stdout: output,
        loadConfig: async () => config,
        loadProfile: async () => ({ profile, profilePath: 'test-profile' }),
        agentFactory: {
          create: async () => fakeAgent,
          resume: async () => {
            throw new Error('not used');
          },
        },
      },
    );

    expect(sentPrompts).toHaveLength(1);
    expect(sentPrompts[0]).toContain('agents-ensemble の operator ロール');
    expect(sentPrompts[0]).toContain('## User message');
    expect(sentPrompts[0]).toContain('hello');
  });
});

function createInput(
  text: string,
  isTTY = true,
): OperatorAgentInput {
  const input = new PassThrough() as PassThrough & OperatorAgentInput;
  input.isTTY = isTTY;
  input.end(text);
  return input;
}

function createOutput(): OperatorAgentOutput & { capturedText: () => string } {
  const output = new PassThrough() as PassThrough &
    OperatorAgentOutput & { capturedText: () => string };
  const chunks: string[] = [];
  output.on('data', (chunk) => chunks.push(String(chunk)));
  output.capturedText = () => chunks.join('');
  output.isTTY = true;
  return output;
}

function createFakeAgent(overrides: {
  send: ConductorAgent['send'];
}): ConductorAgent {
  return {
    agentId: 'operator-agent-id',
    send: overrides.send,
    reload: async () => {},
    getUsage: async () => ({}),
    setSystemPrompt: async () => {},
    close: async () => {},
  };
}
