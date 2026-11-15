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

function createContext(repoRoot = '/tmp/doctor-check-repo'): DoctorCheckContext {
  const config = structuredClone(DEFAULT_ENSEMBLE_CONFIG);
  return {
    repoRoot,
    config,
    auth: {
      backend: 'pi',
      config,
      pi: {
        cwd: repoRoot,
        pi: {
          agentDir: '/tmp/doctor-check-user/pi',
          projectDir: `${repoRoot}/.ensemble/pi`,
        },
      },
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

function createFakeAgent(result = 'Configuration looks consistent.') {
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
      agent: { started: false, turns: 0, answer: null },
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
    });
    expect(report.nextActions).toEqual([
      'ensemble auth status',
      'ensemble auth login',
      'ensemble setup',
    ]);
    expect(createAgentFactory).not.toHaveBeenCalled();
  });

  it('runs exactly one read-only turn for a natural-language request and sanitizes the report', async () => {
    const output = createOutput();
    const answer =
      'API_KEY=plain-secret-sentinel ghp_abcdefghijklmnopqrstuvwxyz123456';
    const agent = createFakeAgent(answer);
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
      request: [
        'check',
        'auth',
        'API_KEY=prompt-secret-sentinel',
        'ghp_abcdefghijklmnopqrstuvwxyz123456',
      ],
      json: true,
      stdout: output.stdout,
      resolveContext: vi.fn(async () => createContext()),
      authCheck: vi.fn(() => true),
      createAgentFactory,
      readSettings: vi.fn(async () => snapshot),
      resolveWorkerSpawn: vi.fn(() => createFakeSpawn()),
      validateWorkerSpawn: vi.fn(),
    });

    expect(report).toMatchObject({
      mode: 'agent',
      agent: { started: true, turns: 1 },
      exitCode: 0,
    });
    expect(report.agent.answer).not.toContain('plain-secret-sentinel');
    expect(report.agent.answer).not.toContain('ghp_');
    expect(agent.send).toHaveBeenCalledOnce();
    expect(agent.send.mock.calls[0]?.[0]).toContain('[redacted]');
    expect(agent.send.mock.calls[0]?.[0]).not.toContain('prompt-secret-sentinel');
    expect(agent.send.mock.calls[0]?.[0]).not.toContain('ghp_');
    expect(createAgentFactory).toHaveBeenCalledOnce();
    expect(createdOptions).toMatchObject({
      builtinTools: false,
      piPromptResources: false,
      piSkills: false,
      piExtensions: false,
      piInternalExtensions: false,
    });
    expect(Object.keys(createdOptions?.customTools ?? {})).toEqual([
      'doctor_read_config',
    ]);
    expect(createdOptions).not.toHaveProperty('mcpServers');
    expect(agent.close).toHaveBeenCalledOnce();
    expect(output.text()).not.toContain('plain-secret-sentinel');
    expect(output.text()).not.toContain('prompt-secret-sentinel');
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

  it('keeps natural-language text output secret-free', async () => {
    const output = createOutput();
    const agent = createFakeAgent('token: text-secret-sentinel');
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

    expect(report.agent.answer).toContain('[redacted]');
    expect(output.text()).toContain('Doctor check (agent)');
    expect(output.text()).not.toContain('text-secret-sentinel');
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
