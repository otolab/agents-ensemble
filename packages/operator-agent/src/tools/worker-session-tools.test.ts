import { readFile, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  resolveEnsemblePaths,
  saveSessionResumeStore as saveOwnedSessionResumeStore,
  type SessionResumeStore,
} from '@agents-ensemble/core';
import { SessionOwnership } from '../../../core/src/session/session-ownership.js';
import { createListOperatorSessionsTool } from './list-operator-sessions-tool.js';
import { createListWorkerMessagesTool } from './worker-session-tools.js';

async function saveSessionResumeStore(path: string, store: Parameters<typeof saveOwnedSessionResumeStore>[1]): Promise<void> {
  const owner = await SessionOwnership.acquire(path);
  try {
    await owner.runWrite((lease) => saveOwnedSessionResumeStore(path, store, owner, lease));
  } finally {
    await owner.closeWritesAndDrain();
    owner.release();
  }
}

const ISSUE_URL = 'https://github.com/example/project/issues/691';
const FIXTURE_PATH = fileURLToPath(
  new URL(
    '../../../core/test/fixtures/pi-acp-worker-session.jsonl',
    import.meta.url,
  ),
);

describe('list_worker_messages', () => {
  let tempRoot = '';
  let repoRoot = '';
  let userEnsembleRoot = '';

  afterEach(async () => {
    vi.unstubAllEnvs();
    if (tempRoot) await rm(tempRoot, { recursive: true, force: true });
    tempRoot = '';
    repoRoot = '';
    userEnsembleRoot = '';
  });

  it('reads the selected run transcript when one Issue has multiple conductorAgentIds', async () => {
    await setupRoots();
    const paths = resolveEnsemblePaths({ repoRoot, userEnsembleRoot });
    const runA = 'run-a';
    const runB = 'run-b';
    const sessionA = 'pi-worker-session-a';
    const sessionB = 'pi-worker-session-b';
    const cwdA = '/tmp/worker-a';
    const cwdB = '/tmp/worker-b';
    await writeWorkerSession(paths, {
      conductorAgentId: runA,
      acpSessionId: sessionA,
      acpCwd: cwdA,
    });
    await writeWorkerSession(paths, {
      conductorAgentId: runB,
      acpSessionId: sessionB,
      acpCwd: cwdB,
    });

    const result = await createListWorkerMessagesTool({
      userEnsembleRoot,
    }).execute({
      issueUrl: ISSUE_URL,
      conductorAgentId: runB,
      worker: 'implementer',
      limit: 1,
    });
    const payload = JSON.parse(result.content[0]!.text) as {
      conductorAgentId: string;
      issueUrl: string;
      status: string;
      messages: Array<{ text: string; providerId: string }>;
      nextCursor?: string;
      hasMore: boolean;
    };

    expect(payload).toMatchObject({
      conductorAgentId: runB,
      issueUrl: ISSUE_URL,
      status: 'supported',
      messages: [
        {
          text: 'Worker reply from run-b.',
          providerId: 'current-assistant',
        },
      ],
      hasMore: true,
    });
    expect(JSON.stringify(payload)).not.toContain('Worker message from run-a.');
    expect(JSON.stringify(payload)).not.toContain('Worker reply from run-a.');

    const next = JSON.parse(
      (
        await createListWorkerMessagesTool({ userEnsembleRoot }).execute({
          issueUrl: ISSUE_URL,
          conductorAgentId: runB,
          worker: 'implementer',
          limit: 1,
          cursor: payload.nextCursor,
        })
      ).content[0]!.text,
    ) as {
      conductorAgentId: string;
      messages: Array<{ text: string }>;
    };
    expect(next.conductorAgentId).toBe(runB);
    expect(next.messages).toEqual([
      expect.objectContaining({ text: 'Worker message from run-b.' }),
    ]);
  });

  it('rejects a cursor from another run when provider ids overlap', async () => {
    await setupRoots();
    const paths = resolveEnsemblePaths({ repoRoot, userEnsembleRoot });
    await writeWorkerSession(paths, {
      conductorAgentId: 'run-a',
      acpSessionId: 'pi-worker-session-a',
      acpCwd: '/tmp/worker-a',
    });
    await writeWorkerSession(paths, {
      conductorAgentId: 'run-b',
      acpSessionId: 'pi-worker-session-b',
      acpCwd: '/tmp/worker-b',
    });
    const tool = createListWorkerMessagesTool({ userEnsembleRoot });
    const runAFirstPage = JSON.parse(
      (
        await tool.execute({
          issueUrl: ISSUE_URL,
          conductorAgentId: 'run-a',
          worker: 'implementer',
          limit: 1,
        })
      ).content[0]!.text,
    ) as {
      messages: Array<{ providerId: string }>;
      nextCursor: string;
    };
    const runBWithRunACursor = await tool.execute({
      issueUrl: ISSUE_URL,
      conductorAgentId: 'run-b',
      worker: 'implementer',
      limit: 1,
      cursor: runAFirstPage.nextCursor,
    });

    expect(runBWithRunACursor.structuredContent).toMatchObject({
      conductorAgentId: 'run-b',
      paginationStatus: 'invalid_cursor',
      returned: 0,
      messages: [],
      paginationReason: expect.stringContaining('different Issue, run'),
    });

    const runAWithDifferentOrder = await tool.execute({
      issueUrl: ISSUE_URL,
      conductorAgentId: 'run-a',
      worker: 'implementer',
      order: 'asc',
      limit: 1,
      cursor: runAFirstPage.nextCursor,
    });
    expect(runAWithDifferentOrder.structuredContent).toMatchObject({
      conductorAgentId: 'run-a',
      paginationStatus: 'invalid_cursor',
      returned: 0,
      messages: [],
      paginationReason: expect.stringContaining('order'),
    });

    const runBFirstPage = JSON.parse(
      (
        await tool.execute({
          issueUrl: ISSUE_URL,
          conductorAgentId: 'run-b',
          worker: 'implementer',
          limit: 1,
        })
      ).content[0]!.text,
    ) as {
      messages: Array<{ text: string; providerId: string }>;
    };
    expect(runBFirstPage.messages[0]).toMatchObject({
      text: 'Worker reply from run-b.',
      providerId: runAFirstPage.messages[0]!.providerId,
    });
  });

  it('reports a configured worker with no saved session record as unavailable', async () => {
    await setupRoots();
    const paths = resolveEnsemblePaths({ repoRoot, userEnsembleRoot });
    const store: SessionResumeStore = {
      version: 1,
      conductorAgentId: 'run-without-worker',
      issueUrl: ISSUE_URL,
      repoRoot,
      profile: {
        workers: [{ name: 'implementer', kind: 'implementer' }],
      },
      openQuestions: [],
      sequence: 0,
      workers: {},
      updatedAt: 1,
    };
    await saveSessionResumeStore(
      paths.canonicalSessionResumeStorePath(ISSUE_URL, store.conductorAgentId),
      store,
    );

    const result = await createListWorkerMessagesTool({
      userEnsembleRoot,
    }).execute({
      issueUrl: ISSUE_URL,
      conductorAgentId: store.conductorAgentId,
      worker: 'implementer',
    });
    expect(result.structuredContent).toMatchObject({
      sessionFound: true,
      workerSessionRecorded: false,
      status: 'unavailable',
      reason: expect.stringContaining('No saved worker session found'),
      messages: [],
    });

    const sessions = JSON.parse(
      (
        await createListOperatorSessionsTool({ userEnsembleRoot }).execute({
          issueUrl: ISSUE_URL,
          conductorAgentId: store.conductorAgentId,
        })
      ).content[0]!.text,
    ) as {
      sessions: Array<{
        configuredWorkers: Array<{ name: string; kind: string }>;
        workers: string[];
        workersWithoutSavedSession: string[];
      }>;
    };
    expect(sessions.sessions[0]).toMatchObject({
      configuredWorkers: [{ name: 'implementer', kind: 'implementer' }],
      workers: [],
      workersWithoutSavedSession: ['implementer'],
    });
  });

  async function setupRoots(): Promise<void> {
    tempRoot = await mkdtemp(join(tmpdir(), 'ensemble-worker-tool-'));
    repoRoot = join(tempRoot, 'saved-repository');
    userEnsembleRoot = join(tempRoot, 'user-ensemble');
    await mkdir(repoRoot, { recursive: true });
    vi.stubEnv('HOME', join(tempRoot, 'home'));
    vi.stubEnv('ENSEMBLE_USER_ROOT', userEnsembleRoot);
  }

  async function writeWorkerSession(
    paths: ReturnType<typeof resolveEnsemblePaths>,
    input: {
      conductorAgentId: string;
      acpSessionId: string;
      acpCwd: string;
    },
  ): Promise<void> {
    const store: SessionResumeStore = {
      version: 1,
      conductorAgentId: input.conductorAgentId,
      issueUrl: ISSUE_URL,
      repoRoot,
      profile: {
        workers: [{ name: 'implementer', kind: 'implementer' }],
      },
      openQuestions: [],
      sequence: 0,
      workers: {
        implementer: {
          acpSessionId: input.acpSessionId,
          acpCwd: input.acpCwd,
          acpSpawn: {
            preset: 'pi',
            command: 'pi-acp',
            args: [],
            piRuntime: 'builtin',
          },
        },
      },
      updatedAt: 1,
    };
    await saveSessionResumeStore(
      paths.canonicalSessionResumeStorePath(ISSUE_URL, input.conductorAgentId),
      store,
    );
    const transcriptPath = join(
      paths.piWorkerSessionsDir('implementer', 691),
      `${input.acpSessionId}.jsonl`,
    );
    await mkdir(dirname(transcriptPath), { recursive: true });
    const transcript = (await readFile(FIXTURE_PATH, 'utf8'))
      .replaceAll('pi-acp-worker-fixture-session', input.acpSessionId)
      .replaceAll('/tmp/pi-acp-worker-fixture', input.acpCwd)
      .replace(
        'Pi ACP fixture user message.',
        `Worker message from ${input.conductorAgentId}.`,
      )
      .replace(
        'Pi ACP fixture assistant reply.',
        `Worker reply from ${input.conductorAgentId}.`,
      );
    await writeFile(transcriptPath, transcript, 'utf8');
    const mapPath = paths.piWorkerSessionMapPath('implementer', 691);
    await mkdir(dirname(mapPath), { recursive: true });
    let map: {
      version: number;
      sessions: Record<
        string,
        { sessionId: string; cwd: string; sessionFile: string; updatedAt: string }
      >;
    } = { version: 1, sessions: {} };
    try {
      map = JSON.parse(await readFile(mapPath, 'utf8')) as typeof map;
    } catch {
      // First run for this Issue creates the map.
    }
    map.sessions[input.acpSessionId] = {
      sessionId: input.acpSessionId,
      cwd: input.acpCwd,
      sessionFile: transcriptPath,
      updatedAt: '2027-01-15T08:00:00.000Z',
    };
    await writeFile(mapPath, JSON.stringify(map), 'utf8');
  }
});
