import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { AcpBridge } from './acp-bridge.js';
import { AcpBridge as AcpBridgeClass } from './acp-bridge.js';
import { AcpClient } from './acp-client.js';
import { loadEnsembleConfig } from '../config/load-ensemble-config.js';
import { profileWorkersToSessionSpecs } from '../profile/types.js';
import { loadProfileFromFile } from '../profile/load-profile.js';
import { attachWorker, runAttachedWorkerPrompt } from '../dispatch/attach-worker.js';
import { closeWorkerAcpSession } from '../dispatch/worker-acp-session.js';
import type { SessionWorkerSpec } from '../profile/types.js';
import type { WorktreeRef } from '../worktree/worktree.js';
import { createInProcessStreamPair } from './testing/stream-pair.js';
import { startFakeAcpServer, type FakeAcpServer } from './testing/fake-acp-server.js';
import {
  acpSpawnFingerprint,
  resolveWorkerAcpSpawn,
  resolvedAcpSpawnToOptions,
} from './resolve-acp-spawn.js';

const ISSUE_URL = 'https://github.com/org/repo/issues/603';

// A real child process observes the resolved spawn env and speaks enough ACP
// to exercise new, prompt, and load without an external model or credentials.
const CAPTURE_ACP_PROCESS = [
  'const fs = require("node:fs");',
  'const config = JSON.parse(process.env.CODEX_CONFIG);',
  'let buffer = "";',
  'process.stdin.setEncoding("utf8");',
  'process.stdin.on("data", (chunk) => {',
  '  buffer += chunk;',
  '  while (buffer.includes("\\n")) {',
  '    const end = buffer.indexOf("\\n");',
  '    const message = JSON.parse(buffer.slice(0, end));',
  '    buffer = buffer.slice(end + 1);',
  '    if (message.id === undefined) continue;',
  '    if (message.method === "session/new" || message.method === "session/load") {',
  '      fs.appendFileSync(process.env.CAPTURE_FILE, JSON.stringify({ method: message.method, config }) + "\\n");',
  '    }',
  '    const result = message.method === "initialize"',
  '      ? { protocolVersion: 1, agentCapabilities: {} }',
  '      : message.method === "session/new"',
  '        ? { sessionId: "captured-session" }',
  '        : message.method === "session/prompt"',
  '          ? { stopReason: "end_turn" } : {};',
  '    process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: message.id, result }) + "\\n");',
  '  }',
  '});',
].join('\n');

type SessionParams = {
  _meta?: {
    claudeCode?: {
      options?: {
        settings?: {
          model?: string;
        };
      };
    };
  };
};

describe('ACP model tag attach and resume', () => {
  let tempRoot = '';

  afterEach(async () => {
    if (tempRoot) {
      await rm(tempRoot, { recursive: true, force: true });
      tempRoot = '';
    }
  });

  it('passes each resolved model to session/new and session/load without rejecting model changes', async () => {
    tempRoot = await mkdtemp(join(tmpdir(), 'ensemble-model-tag-attach-'));
    const repoRoot = join(tempRoot, 'repo');
    const userRoot = join(tempRoot, 'user');
    const configDir = join(repoRoot, '.ensemble');
    await Promise.all([
      mkdir(configDir, { recursive: true }),
      mkdir(userRoot, { recursive: true }),
    ]);

    const userConfigPath = join(userRoot, 'config.yaml');
    const projectConfigPath = join(configDir, 'config.yaml');
    const profilePath = join(tempRoot, 'team', 'profile.yaml');
    await mkdir(join(tempRoot, 'team'), { recursive: true });
    await writeFile(
      userConfigPath,
      [
        'acp:',
        '  defaultPreset: claude',
        '  models:',
        '    opus: gateway/user-opus',
        '    sonnet: gateway/user-sonnet',
        '  tags:',
        '    high: opus',
        '    default: sonnet',
        '',
      ].join('\n'),
    );
    await writeFile(
      projectConfigPath,
      [
        'acp:',
        '  models:',
        '    opus:',
        '      model: gateway/project-opus',
        '      reasoning: high',
        '',
      ].join('\n'),
    );
    await writeFile(
      profilePath,
      [
        'workers:',
        '  - name: implementer',
        '    kind: implementer',
        '    modelTag: high',
        '  - name: reviewer',
        '    kind: reviewer',
        '    modelTag: default',
        '',
      ].join('\n'),
    );

    const profile = await loadProfileFromFile(profilePath, { repoRoot });
    const loadConfig = () =>
      loadEnsembleConfig(repoRoot, {
        userEnsembleRoot: userRoot,
        writeStderr: vi.fn(),
      });
    const config = await loadConfig();
    expect(config.acp.models).toMatchObject({
      opus: { model: 'gateway/project-opus', reasoning: 'high' },
      sonnet: 'gateway/user-sonnet',
    });

    const originalSpecs = profileWorkersToSessionSpecs(profile, {
      defaultAcp: { config },
    });
    const specsByName = new Map(originalSpecs.map((spec) => [spec.name, spec]));
    expect(originalSpecs.map((spec) => spec.spawn?.sessionMeta)).toEqual([
      { claudeCode: { options: { settings: { model: 'gateway/project-opus' } } } },
      { claudeCode: { options: { settings: { model: 'gateway/user-sonnet' } } } },
    ]);
    expect(originalSpecs[0]?.spawn?.sessionConfigOptionOverrides).toEqual([
      { id: 'model', value: 'gateway/project-opus' },
      { id: 'effort', value: 'high' },
    ]);

    const worktree: WorktreeRef = {
      path: repoRoot,
      branch: 'ensemble/issue-603',
      issue: {
        owner: 'org',
        repo: 'repo',
        number: 603,
        url: ISSUE_URL,
      },
      inRepo: true,
    };
    const wireEvents: Array<{ method: 'session/new' | 'session/load'; params: unknown }> = [];
    const wireConfigEvents: Array<{
      sessionId: string;
      configId: string;
      value: string;
    }> = [];
    const bridges: AcpBridge[] = [];
    const servers: FakeAcpServer[] = [];
    const createFakeConnector = (initialSessions: string[] = []) =>
      vi.fn(async ({ spawn }: { spawn?: SessionWorkerSpec['spawn'] }) => {
        const streams = createInProcessStreamPair();
        const configuredModel = spawn?.sessionConfigOptionOverrides?.find(
          ({ id }) => id === 'model',
        )?.value;
        servers.push(
          startFakeAcpServer({
            readable: streams.serverReadable,
            writable: streams.serverWritable,
            initialSessions,
            onNewSession: (params) => {
              wireEvents.push({ method: 'session/new', params });
            },
            onLoadSession: (params) => {
              wireEvents.push({ method: 'session/load', params });
            },
            sessionConfigOptions: [
              {
                id: 'model',
                type: 'select',
                currentValue: 'adapter-default',
                options: [
                  { value: 'adapter-default', name: 'Adapter default' },
                  ...(configuredModel
                    ? [{ value: configuredModel, name: configuredModel }]
                    : []),
                ],
              },
              {
                id: 'effort',
                type: 'select',
                currentValue: 'low',
                options: [
                  { value: 'low', name: 'Low' },
                  { value: 'high', name: 'High' },
                ],
              },
            ],
            onSetConfigOption: (params) => {
              wireConfigEvents.push(params);
            },
          }),
        );
        const client = AcpClient.create(
          {
            readable: streams.clientReadable,
            writable: streams.clientWritable,
          },
          {
            // spawnAcpProcess passes these resolved options to AcpClient;
            // the injected connector replaces only the child process.
            authenticate: spawn?.authenticate,
            sessionMeta: spawn?.sessionMeta,
            clientCapabilitiesMeta: spawn?.clientCapabilitiesMeta,
            sessionConfigOptionOverrides: spawn?.sessionConfigOptionOverrides,
          },
        );
        await client.connect();
        const bridge = AcpBridgeClass.fromClient(client);
        bridges.push(bridge);
        return bridge;
      });

    const sessionState = {
      workers: profile.workers.map(({ name, kind }) => ({ name, kind })),
      kinds: profile.workers.map(({ kind }) => kind),
    };

    try {
      const savedSessions = new Map<string, string>();
      for (const spec of originalSpecs) {
        const connectAcp = createFakeConnector();
        const attached = await attachWorker({
          name: spec.name,
          issueUrl: ISSUE_URL,
          kind: spec.kind,
          worktree,
          sessionState,
          spawn: spec.spawn,
          currentAcpSpawn: spec.acpFingerprint,
          connectAcp,
        });
        savedSessions.set(spec.name, attached.session.sessionId);
        expect(connectAcp).toHaveBeenCalledWith(
          expect.objectContaining({
            spawn: expect.objectContaining(spec.spawn),
          }),
        );
      }

      const initialCalls = wireEvents.filter((event) => event.method === 'session/new');
      expect(initialCalls.map((event) => getClaudeModel(event.params))).toEqual([
        'gateway/project-opus',
        'gateway/user-sonnet',
      ]);
      expect(wireConfigEvents).toEqual([
        {
          sessionId: savedSessions.get('implementer'),
          configId: 'model',
          value: 'gateway/project-opus',
        },
        {
          sessionId: savedSessions.get('implementer'),
          configId: 'effort',
          value: 'high',
        },
        {
          sessionId: savedSessions.get('reviewer'),
          configId: 'model',
          value: 'gateway/user-sonnet',
        },
      ]);

      await writeFile(
        projectConfigPath,
        [
          'acp:',
          '  models:',
          '    opus:',
          '      model: gateway/changed-opus',
          '      reasoning: low',
          '',
        ].join('\n'),
      );
      const changedConfig = await loadConfig();
      const changedSpecs = profileWorkersToSessionSpecs(profile, {
        defaultAcp: { config: changedConfig },
      });
      const changedImplementer = changedSpecs.find(
        (spec) => spec.name === 'implementer',
      )!;
      const changedModelConnector = createFakeConnector([
        savedSessions.get('implementer')!,
      ]);
      const changedResume = await attachWorker({
        name: changedImplementer.name,
        issueUrl: ISSUE_URL,
        kind: changedImplementer.kind,
        worktree,
        sessionState,
        spawn: changedImplementer.spawn,
        expectedResumeAcpSpawn:
          specsByName.get('implementer')?.acpFingerprint,
        currentAcpSpawn: changedImplementer.acpFingerprint,
        resumeAcpSessionId: savedSessions.get('implementer'),
        connectAcp: changedModelConnector,
      });
      expect(changedModelConnector).toHaveBeenCalledOnce();
      expect(changedResume.session.sessionId).toBe(
        savedSessions.get('implementer'),
      );
      const changedLoadCall = wireEvents.find(
        (event) => event.method === 'session/load',
      );
      expect(getClaudeModel(changedLoadCall?.params)).toBe(
        'gateway/changed-opus',
      );
      expect(wireConfigEvents.slice(-2)).toEqual([
        {
          sessionId: savedSessions.get('implementer'),
          configId: 'model',
          value: 'gateway/changed-opus',
        },
        {
          sessionId: savedSessions.get('implementer'),
          configId: 'effort',
          value: 'low',
        },
      ]);

      await writeFile(
        projectConfigPath,
        [
          'acp:',
          '  models:',
          '    opus:',
          '      model: gateway/project-opus',
          '      reasoning: high',
          '',
        ].join('\n'),
      );
      const sameConfig = await loadConfig();
      const sameSpecs = profileWorkersToSessionSpecs(profile, {
        defaultAcp: { config: sameConfig },
      });
      const sameImplementer = sameSpecs.find(
        (spec) => spec.name === 'implementer',
      )!;
      const savedSessionId = savedSessions.get('implementer')!;
      const resumeConnector = createFakeConnector([savedSessionId]);
      const resumed = await attachWorker({
        name: sameImplementer.name,
        issueUrl: ISSUE_URL,
        kind: sameImplementer.kind,
        worktree,
        sessionState,
        spawn: sameImplementer.spawn,
        expectedResumeAcpSpawn:
          specsByName.get('implementer')?.acpFingerprint,
        currentAcpSpawn: sameImplementer.acpFingerprint,
        resumeAcpSessionId: savedSessionId,
        connectAcp: resumeConnector,
      });
      expect(resumed.session.sessionId).toBe(savedSessionId);
      const loadCall = wireEvents.find((event) => event.method === 'session/load');
      expect(loadCall).toBeDefined();
      expect(getClaudeModel(loadCall?.params)).toBe('gateway/project-opus');
      expect(wireConfigEvents.slice(-2)).toEqual([
        {
          sessionId: savedSessionId,
          configId: 'model',
          value: 'gateway/project-opus',
        },
        {
          sessionId: savedSessionId,
          configId: 'effort',
          value: 'high',
        },
      ]);
    } finally {
      await Promise.all(bridges.map((bridge) => bridge.close()));
      for (const server of servers) server.stop();
    }
  });

  it('applies Pi model and reasoning on attach and resume', async () => {
    const preset = 'pi' as const;
    const model = 'openai/gpt-5.5';
    const resolved = resolveWorkerAcpSpawn({
      modelTag: 'high',
      defaultOptions: {
        defaultAcpCli: preset,
        env: {},
        config: {
          acp: {
            models: {
              selected: { model, reasoning: 'high' },
            },
            tags: { high: 'selected' },
          },
        } as import('../config/types.js').EnsembleConfig,
      },
    });
    const spawn = resolvedAcpSpawnToOptions(resolved);
    const fingerprint = acpSpawnFingerprint(resolved);
    const overrides = [
      { id: 'model', value: model },
      { id: 'thought_level', value: 'high' },
    ];
    const expectedOverrides = overrides.map(
      ({ id, value }) => `session/set_config_option:${id}=${value}`,
    );
    expect(spawn.sessionConfigOptionOverrides).toEqual(overrides);
    expect(fingerprint).toMatchObject({ model, reasoning: 'high' });

    const worktree: WorktreeRef = {
      path: process.cwd(),
      branch: 'ensemble/issue-630',
      issue: {
        owner: 'org',
        repo: 'repo',
        number: 630,
        url: 'https://github.com/org/repo/issues/630',
      },
      inRepo: true,
    };
    const sessionState = {
      workers: [{ name: 'implementer', kind: 'implementer' }],
      kinds: ['implementer'],
    };
    const connections: Array<{ events: string[] }> = [];
    const bridges: AcpBridge[] = [];
    const servers: FakeAcpServer[] = [];
    const createFakeConnector = (initialSessions: string[] = []) =>
      vi.fn(async ({ spawn: resolvedSpawn }: {
        spawn?: SessionWorkerSpec['spawn'];
      }) => {
        const streams = createInProcessStreamPair();
        const connection = { events: [] as string[] };
        connections.push(connection);
        const sessionConfigOptions = [
          {
            id: 'model',
            type: 'select',
            currentValue: 'openai/default',
            options: [
              { value: 'openai/default', name: 'Default' },
              { value: model, name: model },
            ],
          },
          {
            id: 'thought_level',
            type: 'select',
            currentValue: 'medium',
            options: [
              { value: 'medium', name: 'Medium' },
              { value: 'high', name: 'High' },
            ],
          },
        ];
        servers.push(
          startFakeAcpServer({
            readable: streams.serverReadable,
            writable: streams.serverWritable,
            initialSessions,
            sessionConfigOptions,
            onInitialize: () => connection.events.push('initialize'),
            onNewSession: () => connection.events.push('session/new'),
            onLoadSession: () => connection.events.push('session/load'),
            onSetConfigOption: ({ configId, value }) => {
              connection.events.push(
                `session/set_config_option:${configId}=${value}`,
              );
            },
            onPrompt: () => {
              connection.events.push('session/prompt');
              return { stopReason: 'end_turn' };
            },
          }),
        );
        const client = AcpClient.create(
          {
            readable: streams.clientReadable,
            writable: streams.clientWritable,
          },
          {
            authenticate: resolvedSpawn?.authenticate,
            sessionMeta: resolvedSpawn?.sessionMeta,
            clientCapabilitiesMeta: resolvedSpawn?.clientCapabilitiesMeta,
            sessionConfigOptionOverrides:
              resolvedSpawn?.sessionConfigOptionOverrides,
          },
        );
        await client.connect();
        const bridge = AcpBridgeClass.fromClient(client);
        bridges.push(bridge);
        return bridge;
      });

    try {
      const attached = await attachWorker({
        name: 'implementer',
        issueUrl: worktree.issue.url,
        kind: 'implementer',
        worktree,
        sessionState,
        spawn,
        currentAcpSpawn: fingerprint,
        connectAcp: createFakeConnector(),
      });
      const sessionId = attached.session.sessionId;
      expect(connections[0]?.events).toEqual([
        'initialize',
        'session/new',
        ...expectedOverrides,
      ]);
      expect(
        (await runAttachedWorkerPrompt(attached, 'new session')).promptResult
          .stopReason,
      ).toBe('end_turn');
      expect(connections[0]?.events.at(-1)).toBe('session/prompt');

      const resumed = await attachWorker({
        name: 'implementer',
        issueUrl: worktree.issue.url,
        kind: 'implementer',
        worktree,
        sessionState,
        spawn,
        expectedResumeAcpSpawn: fingerprint,
        currentAcpSpawn: fingerprint,
        resumeAcpSessionId: sessionId,
        connectAcp: createFakeConnector([sessionId]),
      });
      expect(resumed.session.sessionId).toBe(sessionId);
      expect(connections[1]?.events).toEqual([
        'initialize',
        'session/load',
        ...expectedOverrides,
      ]);
      expect(
        (await runAttachedWorkerPrompt(resumed, 'resumed session')).promptResult
          .stopReason,
      ).toBe('end_turn');
      expect(connections[1]?.events.at(-1)).toBe('session/prompt');
    } finally {
      await Promise.all(bridges.map((bridge) => bridge.close()));
      for (const server of servers) server.stop();
    }
  });

  it('passes merged Codex reasoning to the worker process and checks it on resume', async () => {
    tempRoot = await mkdtemp(join(tmpdir(), 'ensemble-model-reasoning-'));
    const reasoningIssueUrl = 'https://github.com/org/repo/issues/622';
    const repoRoot = join(tempRoot, 'repo');
    const userRoot = join(tempRoot, 'user');
    const projectDir = join(repoRoot, '.ensemble');
    const profilePath = join(tempRoot, 'profile.yaml');
    const capturePath = join(tempRoot, 'capture.jsonl');
    await Promise.all([
      mkdir(projectDir, { recursive: true }),
      mkdir(userRoot, { recursive: true }),
    ]);
    await writeFile(join(userRoot, 'config.yaml'), [
      'acp:',
      '  defaultPreset: codex',
      '  env:',
      `    CODEX_CONFIG: '{"approval_policy":"on-request","model_reasoning_effort":"medium"}'`,
      '  models:',
      '    high-model:',
      '      model: gateway/shared',
      '      reasoning: low',
      '    standard: gateway/standard',
      '  tags:',
      '    high: high-model',
      '    default: standard',
      '',
    ].join('\n'));
    const projectPath = join(projectDir, 'config.yaml');
    await writeFile(projectPath, 'acp:\n  models:\n    high-model:\n      reasoning: high\n');
    await writeFile(profilePath, [
      'workers:',
      '  - name: implementer',
      '    kind: implementer',
      '    modelTag: high',
      '  - reviewer',
      '',
    ].join('\n'));

    const profile = await loadProfileFromFile(profilePath, { repoRoot });
    const loadSpecs = async () => {
      const config = await loadEnsembleConfig(repoRoot, {
        userEnsembleRoot: userRoot,
        writeStderr: vi.fn(),
      });
      return profileWorkersToSessionSpecs(profile, { defaultAcp: { config, env: {} } });
    };
    const specs = await loadSpecs();
    const worktree: WorktreeRef = {
      path: repoRoot,
      branch: 'ensemble/issue-622',
      issue: { owner: 'org', repo: 'repo', number: 622, url: reasoningIssueUrl },
      inRepo: true,
    };
    const sessionState = {
      workers: profile.workers.map(({ name, kind }) => ({ name, kind })),
      kinds: profile.workers.map(({ kind }) => kind),
    };
    const attach = (spec: SessionWorkerSpec, resume?: SessionWorkerSpec) =>
      attachWorker({
        name: spec.name,
        kind: spec.kind,
        issueUrl: reasoningIssueUrl,
        worktree,
        sessionState,
        spawn: {
          ...spec.spawn,
          command: process.execPath,
          args: ['-e', CAPTURE_ACP_PROCESS],
          env: { ...spec.spawn?.env, CAPTURE_FILE: capturePath },
        },
        currentAcpSpawn: spec.acpFingerprint,
        ...(resume ? {
          expectedResumeAcpSpawn: resume.acpFingerprint,
          resumeAcpSessionId: 'captured-session',
        } : {}),
      });
    const captured = async () => (await readFile(capturePath, 'utf8'))
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line));

    for (const spec of specs) {
      const worker = await attach(spec);
      try {
        expect((await runAttachedWorkerPrompt(worker, 'test')).promptResult.stopReason).toBe('end_turn');
      } finally {
        await closeWorkerAcpSession(worker.session);
      }
    }
    expect(await captured()).toEqual([
      {
        method: 'session/new',
        config: {
          approval_policy: 'on-request',
          model: 'gateway/shared',
          model_reasoning_effort: 'high',
        },
      },
      {
        method: 'session/new',
        config: {
          approval_policy: 'on-request',
          model: 'gateway/standard',
          model_reasoning_effort: 'medium',
        },
      },
    ]);

    const original = specs[0]!;
    await writeFile(projectPath, 'acp:\n  models:\n    high-model:\n      reasoning: xhigh\n');
    const changed = (await loadSpecs())[0]!;
    const changedResume = await attach(changed, original);
    await closeWorkerAcpSession(changedResume.session);
    expect((await captured())[2]).toMatchObject({
      method: 'session/load',
      config: {
        model: 'gateway/shared',
        model_reasoning_effort: 'xhigh',
      },
    });

    const resumed = await attach(original, original);
    await closeWorkerAcpSession(resumed.session);
    expect((await captured())[3]).toMatchObject({
      method: 'session/load',
      config: { model: 'gateway/shared', model_reasoning_effort: 'high' },
    });
  });
});

function getClaudeModel(params: unknown): string | undefined {
  return (params as SessionParams)._meta?.claudeCode?.options?.settings?.model;
}
