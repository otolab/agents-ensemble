import { Writable } from 'node:stream';
import { describe, expect, it, vi } from 'vitest';
import {
  DEFAULT_ENSEMBLE_CONFIG,
  type ConductorAgent,
  type ConductorAgentCreateOptions,
  type ConductorAgentFactory,
  type DoctorConfigSnapshot,
  type ResolvedAcpSpawn,
} from '@agents-ensemble/core';
import type { DoctorCheckContext } from './doctor-check-command.js';
import { runDoctorCheckCommand } from './doctor-check-command.js';

function createOutput() {
  let value = '';
  const stdout = new Writable({
    write(chunk, _encoding, callback) {
      value += String(chunk);
      callback();
    },
  });
  return { stdout, text: () => value };
}

function createContext(
  repoRoot = '/tmp/doctor-check-repo',
  backend: 'cursor' | 'pi' = 'pi',
): DoctorCheckContext {
  const config = structuredClone(DEFAULT_ENSEMBLE_CONFIG);
  return {
    repoRoot,
    config,
    auth:
      backend === 'pi'
        ? {
            backend,
            config,
            pi: {
              cwd: repoRoot,
              pi: {
                agentDir: '/tmp/doctor-check-user/pi',
                projectDir: `${repoRoot}/.ensemble/pi`,
              },
            },
          }
        : {
            backend,
            config,
          },
  };
}

const snapshot: DoctorConfigSnapshot = {
  projectConfigEnabled: true,
  settings: [
    {
      key: 'acp.defaultPreset',
      value: 'cursor',
      source: 'project',
    },
    {
      key: 'session.worktree',
      value: 'isolated',
      source: 'default',
    },
    {
      key: 'session.lazyWorkers',
      value: true,
      source: 'user',
    },
    {
      key: 'github.auth.allowGhAuthTokenFallback',
      value: true,
      source: 'default',
    },
  ],
};

function createFakeSpawn(): ResolvedAcpSpawn {
  return { preset: 'cursor', command: '/tmp/fake-agent', args: [] };
}

function createFakeAgent(result = 'no_matching_diagnosis') {
  return {
    agentId: 'fake-doctor-agent',
    send: vi.fn().mockResolvedValue({
      runId: 'doctor-check-run',
      status: 'finished',
      result,
    }),
    close: vi.fn().mockResolvedValue(undefined),
    cancel: vi.fn().mockResolvedValue(undefined),
    reload: vi.fn().mockResolvedValue(undefined),
    getUsage: vi.fn().mockResolvedValue({}),
    setSystemPrompt: vi.fn().mockResolvedValue(undefined),
  } satisfies ConductorAgent;
}

describe('runDoctorCheckCommand', () => {
  it('emits a deterministic JSON report without creating or prompting an agent when no request is given', async () => {
    const output = createOutput();
    const agentFactory = {
      create: vi.fn(),
      resume: vi.fn(),
    } as unknown as ConductorAgentFactory;
    const resolveFactory = vi.fn(() => agentFactory);
    const validateWorkerSpawn = vi.fn();

    const report = await runDoctorCheckCommand({
      repoRoot: '/tmp/doctor-check-repo',
      json: true,
      stdout: output.stdout,
      resolveContext: vi.fn(async () => createContext()),
      authCheck: vi.fn(() => true),
      createAgentFactory: resolveFactory,
      readSettings: vi.fn(async () => snapshot),
      resolveWorkerSpawn: vi.fn(() => createFakeSpawn()),
      validateWorkerSpawn,
    });

    expect(report).toMatchObject({
      schemaVersion: 1,
      mode: 'basic',
      agent: {
        started: false,
        turns: 0,
        answer: null,
        answerCode: null,
        answerStatus: 'not_requested',
      },
      exitCode: 0,
    });
    expect(report.checks.map(({ id }) => id)).toEqual([
      'conductor.auth',
      'worker.spawn',
      'config.read',
    ]);
    expect(JSON.parse(output.text())).toEqual(report);
    expect(resolveFactory).not.toHaveBeenCalled();
    expect(agentFactory.create).not.toHaveBeenCalled();
    expect(validateWorkerSpawn).toHaveBeenCalledOnce();
  });

  it('reports missing auth and setup actions without starting the requested agent', async () => {
    const output = createOutput();
    const createAgentFactory = vi.fn();
    const report = await runDoctorCheckCommand({
      request: 'check the worker setup',
      stdout: output.stdout,
      resolveContext: vi.fn(async () => createContext()),
      authCheck: vi.fn(() => false),
      createAgentFactory,
      readSettings: vi.fn(async () => snapshot),
      resolveWorkerSpawn: vi.fn(() => createFakeSpawn()),
      validateWorkerSpawn: vi.fn(),
    });

    expect(report.exitCode).toBe(1);
    expect(report.agent).toEqual({
      started: false,
      turns: 0,
      answer: null,
      answerCode: null,
      answerStatus: 'unavailable',
    });
    expect(report.nextActions).toEqual([
      'ensemble auth status',
      'ensemble auth login',
      'ensemble setup',
    ]);
    expect(createAgentFactory).not.toHaveBeenCalled();
  });

  it('maps an allowed diagnostic code to a fixed answer for the natural-language request', async () => {
    const output = createOutput();
    const agent = createFakeAgent('config.acp.defaultPreset');
    const context = createContext();
    context.config.acp.env = {
      PRIVATE_CONFIG_SENTINEL: 'acp-env-secret-sentinel',
    };
    let createdOptions: ConductorAgentCreateOptions | undefined;
    const factory: ConductorAgentFactory = {
      create: vi.fn(async (options) => {
        createdOptions = options;
        return agent;
      }),
      resume: vi.fn(),
    };
    const createAgentFactory = vi.fn(() => factory);
    const report = await runDoctorCheckCommand({
      request: 'which worker preset is configured?',
      json: true,
      stdout: output.stdout,
      resolveContext: vi.fn(async () => context),
      authCheck: vi.fn(() => true),
      createAgentFactory,
      readSettings: vi.fn(async () => snapshot),
      resolveWorkerSpawn: vi.fn(() => createFakeSpawn()),
      validateWorkerSpawn: vi.fn(),
    });

    expect(report).toMatchObject({
      mode: 'agent',
      agent: {
        started: true,
        turns: 1,
        answer:
          'acp.defaultPreset は cursor です（source: project）。',
        answerCode: 'config.acp.defaultPreset',
        answerStatus: 'mapped',
      },
      exitCode: 0,
    });
    expect(agent.send).toHaveBeenCalledOnce();
    expect(agent.send.mock.calls[0]?.[0]).toContain(
      'which worker preset is configured?',
    );
    expect(createAgentFactory).toHaveBeenCalledOnce();
    expect(createdOptions).toMatchObject({
      builtinTools: false,
      piPromptResources: false,
      piSkills: false,
      piExtensions: false,
      piInternalExtensions: false,
    });
    expect(createdOptions?.systemPrompt).toContain(
      'config.acp.defaultPreset',
    );
    expect(Object.keys(createdOptions?.customTools ?? {})).toEqual([
      'doctor_read_config',
    ]);
    expect(createdOptions).not.toHaveProperty('mcpServers');
    expect(agent.close).toHaveBeenCalledOnce();
    expect(output.text()).toContain('acp.defaultPreset は cursor');
    expect(output.text()).not.toContain('acp-env-secret-sentinel');
    expect(output.text()).not.toContain('PRIVATE_CONFIG_SENTINEL');
    expect(JSON.stringify(report)).not.toContain('acp-env-secret-sentinel');
  });

  it('maps a worker diagnosis code to the failed prerequisite and fixed next step', async () => {
    const output = createOutput();
    const agent = createFakeAgent('worker.spawn');
    const factory: ConductorAgentFactory = {
      create: vi.fn().mockResolvedValue(agent),
      resume: vi.fn(),
    };
    const report = await runDoctorCheckCommand({
      request: 'why is the worker preset unavailable?',
      stdout: output.stdout,
      resolveContext: vi.fn(async () => createContext()),
      authCheck: vi.fn(() => true),
      createAgentFactory: vi.fn(() => factory),
      readSettings: vi.fn(async () => snapshot),
      resolveWorkerSpawn: vi.fn(() => createFakeSpawn()),
      validateWorkerSpawn: vi.fn(() => {
        throw new Error('private adapter failure');
      }),
    });

    expect(report.agent.answerCode).toBe('worker.spawn');
    expect(report.agent.answerStatus).toBe('mapped');
    expect(report.agent.answer).toContain(
      'worker adapter / CLI の spawn 前提を確認できませんでした。',
    );
    expect(report.agent.answer).toContain('PATH');
    expect(output.text()).toContain('設定済み worker preset');
    expect(output.text()).not.toContain('private adapter failure');
    expect(agent.send).toHaveBeenCalledOnce();
  });

  it('replaces arbitrary response text and secrets with a fixed generic answer', async () => {
    const output = createOutput();
    const secret = 'opaque-secret-sentinel-123';
    const agent = createFakeAgent(
      `${secret}; unexpected free-form diagnostic text`,
    );
    const factory: ConductorAgentFactory = {
      create: vi.fn().mockResolvedValue(agent),
      resume: vi.fn(),
    };
    const report = await runDoctorCheckCommand({
      request: `check this value ${secret}`,
      json: true,
      stdout: output.stdout,
      resolveContext: vi.fn(async () => createContext()),
      authCheck: vi.fn(() => true),
      createAgentFactory: vi.fn(() => factory),
      readSettings: vi.fn(async () => snapshot),
      resolveWorkerSpawn: vi.fn(() => createFakeSpawn()),
      validateWorkerSpawn: vi.fn(),
    });

    expect(report.agent).toMatchObject({
      started: true,
      turns: 1,
      answerCode: 'no_matching_diagnosis',
      answerStatus: 'generic',
    });
    expect(report.agent.answer).toContain('安全な診断項目');
    expect(agent.send).toHaveBeenCalledOnce();
    expect(output.text()).not.toContain(secret);
    expect(JSON.stringify(report)).not.toContain(secret);
    expect(JSON.parse(output.text())).toEqual(report);
  });

  it('fails closed for Cursor natural-language requests without creating an agent', async () => {
    const output = createOutput();
    const createAgentFactory = vi.fn();
    const report = await runDoctorCheckCommand({
      request: 'diagnose the worker setup',
      json: true,
      stdout: output.stdout,
      resolveContext: vi.fn(async () => createContext(undefined, 'cursor')),
      authCheck: vi.fn(() => true),
      createAgentFactory,
      readSettings: vi.fn(async () => snapshot),
      resolveWorkerSpawn: vi.fn(() => createFakeSpawn()),
      validateWorkerSpawn: vi.fn(),
    });

    expect(report).toMatchObject({
      mode: 'agent',
      agent: {
        started: false,
        turns: 0,
        answer: null,
        answerCode: null,
        answerStatus: 'unavailable',
      },
      error: { code: 'backend_unsupported' },
      exitCode: 2,
    });
    expect(report.nextActions[0]).toContain('Pi backend');
    expect(JSON.parse(output.text())).toEqual(report);
    expect(createAgentFactory).not.toHaveBeenCalled();
  });

  it('prioritizes Cursor unsupported status while preserving missing auth details', async () => {
    const output = createOutput();
    const createAgentFactory = vi.fn();
    const report = await runDoctorCheckCommand({
      request: 'diagnose GitHub access',
      json: true,
      stdout: output.stdout,
      resolveContext: vi.fn(async () => createContext(undefined, 'cursor')),
      authCheck: vi.fn(() => false),
      createAgentFactory,
      readSettings: vi.fn(async () => snapshot),
      resolveWorkerSpawn: vi.fn(() => createFakeSpawn()),
      validateWorkerSpawn: vi.fn(),
    });

    expect(report.exitCode).toBe(2);
    expect(report.error).toMatchObject({ code: 'backend_unsupported' });
    expect(report.checks.find(({ id }) => id === 'conductor.auth')).toMatchObject({
      status: 'fail',
      action: expect.stringContaining('ensemble auth login'),
    });
    expect(report.nextActions).toEqual(
      expect.arrayContaining([
        'ensemble auth status',
        'ensemble auth login',
        'ensemble setup',
        expect.stringContaining('Pi backend'),
      ]),
    );
    expect(JSON.parse(output.text())).toEqual(report);
    expect(createAgentFactory).not.toHaveBeenCalled();
  });

  it('treats empty positional words as no request', async () => {
    const output = createOutput();
    const createAgentFactory = vi.fn();
    const report = await runDoctorCheckCommand({
      request: [' ', ''],
      stdout: output.stdout,
      resolveContext: vi.fn(async () => createContext()),
      authCheck: vi.fn(() => true),
      createAgentFactory,
      readSettings: vi.fn(async () => snapshot),
      resolveWorkerSpawn: vi.fn(() => createFakeSpawn()),
      validateWorkerSpawn: vi.fn(),
    });

    expect(report.mode).toBe('basic');
    expect(report.agent.turns).toBe(0);
    expect(createAgentFactory).not.toHaveBeenCalled();
  });

  it('keeps invalid secret-bearing responses out of text output', async () => {
    const output = createOutput();
    const secret = 'opaque-secret-sentinel-456';
    const agent = createFakeAgent(
      `config.acp.defaultPreset\n${secret}`,
    );
    const factory: ConductorAgentFactory = {
      create: vi.fn().mockResolvedValue(agent),
      resume: vi.fn(),
    };

    const report = await runDoctorCheckCommand({
      request: 'summarize the auth check',
      stdout: output.stdout,
      resolveContext: vi.fn(async () => createContext()),
      authCheck: vi.fn(() => true),
      createAgentFactory: vi.fn(() => factory),
      readSettings: vi.fn(async () => snapshot),
      resolveWorkerSpawn: vi.fn(() => createFakeSpawn()),
      validateWorkerSpawn: vi.fn(),
    });

    expect(report.agent.answerCode).toBe('no_matching_diagnosis');
    expect(report.agent.answerStatus).toBe('generic');
    expect(output.text()).toContain('Doctor check (agent)');
    expect(output.text()).toContain('安全な診断項目');
    expect(output.text()).not.toContain(secret);
  });

  it('uses the non-zero report code when a local prerequisite fails', async () => {
    const output = createOutput();
    const report = await runDoctorCheckCommand({
      stdout: output.stdout,
      resolveContext: vi.fn(async () => createContext()),
      authCheck: vi.fn(() => true),
      readSettings: vi.fn(async () => snapshot),
      resolveWorkerSpawn: vi.fn(() => createFakeSpawn()),
      validateWorkerSpawn: vi.fn(() => {
        throw new Error('fake ACP is missing');
      }),
    });

    expect(report.exitCode).toBe(1);
    expect(report.checks.find(({ id }) => id === 'worker.spawn')).toMatchObject({
      status: 'fail',
    });
    expect(output.text()).not.toContain('fake ACP is missing');
  });
});
