import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { AcpBridge } from './acp-bridge.js';
import { AcpBridge as AcpBridgeClass } from './acp-bridge.js';
import { AcpClient } from './acp-client.js';
import { loadEnsembleConfig } from '../config/load-ensemble-config.js';
import { profileWorkersToSessionSpecs } from '../profile/types.js';
import { loadProfileFromFile } from '../profile/load-profile.js';
import { attachWorker } from '../dispatch/attach-worker.js';
import type { SessionWorkerSpec } from '../profile/types.js';
import type { WorktreeRef } from '../worktree/worktree.js';
import { createInProcessStreamPair } from './testing/stream-pair.js';
import { startFakeAcpServer, type FakeAcpServer } from './testing/fake-acp-server.js';

const ISSUE_URL = 'https://github.com/org/repo/issues/603';

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

  it('passes each resolved model to session/new and session/load, and rejects a changed model before load', async () => {
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
        '    opus: gateway/project-opus',
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
      opus: 'gateway/project-opus',
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
    const bridges: AcpBridge[] = [];
    const servers: FakeAcpServer[] = [];
    const createFakeConnector = (initialSessions: string[] = []) =>
      vi.fn(async ({ spawn }: { spawn?: SessionWorkerSpec['spawn'] }) => {
        const streams = createInProcessStreamPair();
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
            sessionMeta: spawn?.sessionMeta,
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

      await writeFile(
        projectConfigPath,
        ['acp:', '  models:', '    opus: gateway/changed-opus', ''].join('\n'),
      );
      const changedConfig = await loadConfig();
      const changedSpecs = profileWorkersToSessionSpecs(profile, {
        defaultAcp: { config: changedConfig },
      });
      const changedImplementer = changedSpecs.find(
        (spec) => spec.name === 'implementer',
      )!;
      const mismatchConnector = createFakeConnector([
        savedSessions.get('implementer')!,
      ]);
      await expect(
        attachWorker({
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
          connectAcp: mismatchConnector,
        }),
      ).rejects.toThrow(/resume ACP spawn mismatch/);
      expect(mismatchConnector).not.toHaveBeenCalled();
      expect(wireEvents.some((event) => event.method === 'session/load')).toBe(false);

      await writeFile(
        projectConfigPath,
        ['acp:', '  models:', '    opus: gateway/project-opus', ''].join('\n'),
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
    } finally {
      await Promise.all(bridges.map((bridge) => bridge.close()));
      for (const server of servers) server.stop();
    }
  });
});

function getClaudeModel(params: unknown): string | undefined {
  return (params as SessionParams)._meta?.claudeCode?.options?.settings?.model;
}
