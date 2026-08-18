import { mkdtemp, mkdir, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  assertSessionSidecarMatches,
  findLatestSessionSidecarForIssue,
  loadSessionSidecar,
  requireSessionSidecarForResume,
  saveSessionSidecar,
  SESSION_SIDECAR_VERSION,
  sessionSidecarDir,
  sessionSidecarPath,
  SessionSidecarNotFoundError,
  type SessionSidecar,
} from './session-sidecar.js';

function baseSidecar(
  overrides: Partial<SessionSidecar> & Pick<SessionSidecar, 'conductorAgentId'>,
): SessionSidecar {
  return {
    version: SESSION_SIDECAR_VERSION,
    issueUrl: 'https://github.com/org/repo/issues/1',
    repoRoot: overrides.repoRoot ?? '/repo',
    profile: { workers: [] },
    openQuestions: [],
    sequence: 0,
    workers: {},
    updatedAt: 0,
    ...overrides,
  };
}

describe('session sidecar', () => {
  let tempDir = '';

  afterEach(() => {
    tempDir = '';
  });

  it('round-trips through the filesystem and sets updatedAt on save', async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'ensemble-sidecar-'));
    const path = sessionSidecarPath({
      repoRoot: tempDir,
      conductorAgentId: 'agent-1',
    });
    const sidecar = baseSidecar({
      conductorAgentId: 'agent-1',
      repoRoot: tempDir,
      profile: {
        workers: [{ name: 'implementer', kind: 'implementer' }],
      },
      sequence: 2,
      workers: {
        implementer: { acpSessionId: 'sess-1', acpCwd: '/repo/docs' },
      },
    });

    const before = Date.now();
    await saveSessionSidecar(path, sidecar);
    const loaded = await loadSessionSidecar(path);

    expect(loaded?.updatedAt).toBeGreaterThanOrEqual(before);
    expect(loaded).toMatchObject({
      ...sidecar,
      updatedAt: expect.any(Number),
    });
    expect(JSON.parse(await readFile(path, 'utf8')).updatedAt).toEqual(
      loaded?.updatedAt,
    );
  });

  it('round-trips worker acpSpawn through save and load', async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'ensemble-sidecar-'));
    const path = sessionSidecarPath({
      repoRoot: tempDir,
      conductorAgentId: 'agent-acp-spawn',
    });
    const sidecar = baseSidecar({
      conductorAgentId: 'agent-acp-spawn',
      repoRoot: tempDir,
      workers: {
        implementer: {
          acpSessionId: 'sess-1',
          acpCwd: '/repo/worktree',
          acpSpawn: {
            preset: 'claude',
            command: 'npx',
            args: ['-y', '@agentclientprotocol/claude-agent-acp'],
          },
        },
      },
    });

    await saveSessionSidecar(path, sidecar);
    const loaded = await loadSessionSidecar(path);

    expect(loaded?.workers.implementer?.acpSpawn).toEqual({
      preset: 'claude',
      command: 'npx',
      args: ['-y', '@agentclientprotocol/claude-agent-acp'],
    });
  });

  it('rejects mismatched issueUrl on assert', () => {
    const sidecar = baseSidecar({
      conductorAgentId: 'agent-1',
      repoRoot: '/repo',
    });

    expect(() =>
      assertSessionSidecarMatches(sidecar, {
        conductorAgentId: 'agent-1',
        issueUrl: 'https://github.com/org/repo/issues/2',
        repoRoot: '/repo',
      }),
    ).toThrow(/issueUrl mismatch/);
  });

  it('throws SessionSidecarNotFoundError when resume sidecar is missing', async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'ensemble-sidecar-'));

    await expect(
      requireSessionSidecarForResume({
        repoRoot: tempDir,
        conductorAgentId: 'missing-agent',
      }),
    ).rejects.toThrow(SessionSidecarNotFoundError);
  });

  it('finds the latest sidecar for an issue by updatedAt', async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'ensemble-sidecar-'));
    const issueUrl = 'https://github.com/org/repo/issues/9';
    const dir = sessionSidecarDir(tempDir);
    await mkdir(dir, { recursive: true });

    const write = async (
      agentId: string,
      updatedAt: number,
      url = issueUrl,
    ) => {
      const sidecar = baseSidecar({
        conductorAgentId: agentId,
        repoRoot: tempDir,
        issueUrl: url,
        updatedAt,
      });
      await writeFile(
        join(dir, `${agentId}.json`),
        `${JSON.stringify(sidecar)}\n`,
        'utf8',
      );
    };

    await write('agent-old', 100);
    await write('agent-new', 200);
    await write(
      'agent-other',
      999,
      'https://github.com/org/repo/issues/99',
    );

    const latest = await findLatestSessionSidecarForIssue({
      repoRoot: tempDir,
      issueUrl,
    });

    expect(latest?.conductorAgentId).toBe('agent-new');
  });
});
