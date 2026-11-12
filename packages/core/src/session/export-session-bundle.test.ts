import {
  copyFile,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  symlink,
  writeFile,
} from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { SessionManager } from '@earendil-works/pi-coding-agent';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { resolveEnsemblePaths } from '../ensemble-paths.js';
import { ENSEMBLE_USER_ROOT_ENV } from '../resolve-user-ensemble-root.js';
import {
  PI_CONDUCTOR_MESSAGE_HISTORY_ENTRY_TYPE,
} from '../conductor/pi-conductor-agent.js';
import { listConductorProviderHistory } from '../conductor/conductor-history.js';

const { listRuns, getRun } = vi.hoisted(() => ({
  listRuns: vi.fn(),
  getRun: vi.fn(),
}));

vi.mock('@cursor/sdk', () => ({
  Agent: { listRuns, getRun },
}));

import { exportSessionBundle } from './export-session-bundle.js';

const SESSION_ID = 'session-export-worktree-fixture';
const ISSUE_URL = 'https://github.com/otolab/agents-ensemble/issues/672';
const CODEX_SESSION_ID = '019a4b21-9c0e-7a44-b9ad-6a8df4fa7720';
const CODEX_CWD = '/tmp/codex-acp-worker-fixture';
const CODEX_FILENAME_TIMESTAMP = '2026-11-09T14-03-00';
const RESUME_STORE_FIXTURE = fileURLToPath(
  new URL(
    '../../test/fixtures/session-export/worktree-codex-session.json',
    import.meta.url,
  ),
);
const CODEX_ROLLOUT_FIXTURE = fileURLToPath(
  new URL(
    '../../test/fixtures/codex-cli-worker-rollout.jsonl',
    import.meta.url,
  ),
);
const CURSOR_RUN_FIXTURE = fileURLToPath(
  new URL(
    '../../test/fixtures/session-export/cursor-run.json',
    import.meta.url,
  ),
);

describe('exportSessionBundle', () => {
  let tempRoot = '';
  let repoRoot = '';
  let conductorCwd = '';
  let userRoot = '';
  let codexHome = '';
  let paths: ReturnType<typeof resolveEnsemblePaths>;
  let resumeStorePath = '';
  let piTranscriptPath = '';
  let codexRolloutPath = '';

  beforeEach(async () => {
    vi.resetAllMocks();
    tempRoot = await mkdtemp(join(tmpdir(), 'ensemble-session-export-'));
    repoRoot = join(tempRoot, 'repository');
    conductorCwd = join(
      repoRoot,
      '.ensemble',
      'worktrees',
      'issue-672',
    );
    userRoot = join(tempRoot, 'user-ensemble');
    codexHome = join(tempRoot, 'codex-home');
    await Promise.all([
      mkdir(conductorCwd, { recursive: true }),
      mkdir(userRoot, { recursive: true }),
      mkdir(codexHome, { recursive: true }),
    ]);
    vi.stubEnv(ENSEMBLE_USER_ROOT_ENV, userRoot);
    vi.stubEnv('CODEX_HOME', codexHome);
    paths = resolveEnsemblePaths({ repoRoot, userEnsembleRoot: userRoot });
    resumeStorePath = paths.sessionResumeStorePath(SESSION_ID);
    await writeResumeStore();
    await writeCodexWorkerRollout();
    await writeSessionSnapshots();
    piTranscriptPath = writePiConductorHistory();
  });

  afterEach(async () => {
    vi.unstubAllEnvs();
    if (tempRoot) await rm(tempRoot, { recursive: true, force: true });
    tempRoot = '';
  });

  it('copies a worktree Pi transcript and an unbounded Codex worker result with hashes', async () => {
    const outputDirectory = join(tempRoot, 'bundle');
    const summaryPath = join(tempRoot, 'summary.json');
    const harnessLogPath = join(tempRoot, 'harness.log');
    await writeCodexWorkerRollout(101);
    await writeFile(summaryPath, '{"lastError":{"message":"SUMMARY_RAW"}}\n');
    await writeFile(harnessLogPath, '[harness] raw stderr\n');
    const toolCallsPath = paths.toolCallHistoryPath(SESSION_ID);
    await mkdir(dirname(toolCallsPath), { recursive: true });
    await writeFile(toolCallsPath, '{"workerName":"implementer"}\n');

    const result = await exportSessionBundle({
      repoRoot,
      conductorAgentId: SESSION_ID,
      outputDirectory,
      ensembleVersion: '0.21.0',
      cliVersion: '0.21.1',
      includeToolCalls: true,
      summaryPath,
      harnessLogPath,
      now: () => new Date('2026-11-12T04:00:00.000Z'),
    });

    expect(result.status).toBe('complete');
    expect(result.fileCount).toBe(8);
    expect(result.warnings).toEqual([]);
    expect(result.manifest).toMatchObject({
      schemaVersion: 1,
      exportedAt: '2026-11-12T04:00:00.000Z',
      versions: { ensemble: '0.21.0', cli: '0.21.1' },
      session: {
        conductorAgentId: SESSION_ID,
        issueUrl: ISSUE_URL,
        repoRoot,
        conductorCwd,
        backend: 'pi',
        lifecycle: 'closed',
        harnessPhase: 'close',
        workers: [
          {
            name: 'implementer',
            kind: 'implementer',
            preset: 'codex',
            reader: 'codex-cli-rollout-jsonl',
            acpSessionId: CODEX_SESSION_ID,
            acpCwd: CODEX_CWD,
          },
        ],
      },
    });

    const resumeCopy = await readFile(
      join(outputDirectory, 'session/session-resume-store.json'),
    );
    expect(resumeCopy).toEqual(await readFile(resumeStorePath));
    expect(resumeCopy.toString()).toContain('api_key=raw-fixture-secret');

    const piCopyPath = join(outputDirectory, 'conductor/pi-transcript.jsonl');
    const piCopy = await readFile(piCopyPath);
    expect(piCopy).toEqual(await readFile(piTranscriptPath));
    expect(piCopy.toString()).toContain('turn-000-inbound');
    expect(piCopy.toString()).toContain('turn-100-inbound');
    expect(piCopy.toString()).not.toContain('LEGACY_PI_TRANSCRIPT');

    const providerHistory = await listConductorProviderHistory({
      backend: 'pi',
      conductorAgentId: SESSION_ID,
      cwd: conductorCwd,
      repoRoot,
      query: { limit: 100, order: 'asc' },
    });
    expect(providerHistory.messages).toHaveLength(100);
    expect(
      providerHistory.messages.some((message) =>
        message.inbound.includes('turn-000-inbound'),
      ),
    ).toBe(false);

    const workerBundlePath =
      result.manifest.session.workers[0]!.bundlePath;
    const workerHistory = JSON.parse(
      await readFile(join(outputDirectory, workerBundlePath), 'utf8'),
    );
    expect(workerHistory).toMatchObject({
      conductorAgentId: SESSION_ID,
      worker: 'implementer',
      preset: 'codex',
      status: 'supported',
      sourceFiles: [codexRolloutPath],
      messages: expect.arrayContaining([
        expect.objectContaining({ role: 'user' }),
        expect.objectContaining({ role: 'assistant' }),
      ]),
    });
    expect(workerHistory.messages).toHaveLength(204);
    expect(workerHistory.messages.at(-1)).toMatchObject({
      role: 'assistant',
      text: 'unbounded-100-assistant',
    });

    const expectedRawFiles = [
      ['harness/session-state.yaml', paths.sessionStatePath(SESSION_ID)],
      ['harness/open-questions.yaml', paths.openQuestionsPath(SESSION_ID)],
      ['harness/session.tool-calls', toolCallsPath],
      ['inputs/session-summary.json', summaryPath],
      ['inputs/harness.log', harnessLogPath],
    ];
    for (const [bundlePath, sourcePath] of expectedRawFiles) {
      expect(await readFile(join(outputDirectory, bundlePath!))).toEqual(
        await readFile(sourcePath!),
      );
    }

    for (const file of result.manifest.files) {
      const bytes = await readFile(join(outputDirectory, file.path));
      expect(bytes.byteLength).toBe(file.sizeBytes);
      expect(createHash('sha256').update(bytes).digest('hex')).toBe(
        file.sha256,
      );
    }
    expect(
      result.manifest.sources.find(
        (source) => source.id === 'conductor.piTranscript',
      ),
    ).toMatchObject({
      status: 'copied',
      sourcePaths: [piTranscriptPath],
      bundlePaths: ['conductor/pi-transcript.jsonl'],
    });
    expect(result.manifest.sources).toContainEqual(
      expect.objectContaining({
        id: 'input.summary',
        status: 'copied',
        sourcePaths: [summaryPath],
      }),
    );
    expect(result.manifest.files.some((file) => file.path === 'manifest.json'))
      .toBe(false);
  });

  it('records all Cursor run snapshots in the bundle', async () => {
    const fixture = JSON.parse(await readFile(CURSOR_RUN_FIXTURE, 'utf8')) as {
      metadata: {
        agentId: string;
        id: string;
        status: string;
        requestId: string;
        createdAt: number;
        result: string;
      };
      conversation: unknown;
    };
    await writeResumeStore({ backend: 'cursor' });
    const firstPage = Array.from({ length: 100 }, (_, index) => ({
      ...fixture.metadata,
      id: `cursor-run-${index}`,
    }));
    listRuns
      .mockResolvedValueOnce({ items: firstPage, nextCursor: 'page-2' })
      .mockResolvedValueOnce({
        items: [{ ...fixture.metadata, id: 'cursor-run-100' }],
      });
    getRun.mockImplementation(async (id: string) => ({
      ...fixture.metadata,
      id,
      conversation: async () => fixture.conversation,
    }));

    const outputDirectory = join(tempRoot, 'cursor-bundle');
    const result = await exportSessionBundle({
      repoRoot,
      conductorAgentId: SESSION_ID,
      outputDirectory,
      ensembleVersion: '0.21.0',
      cliVersion: '0.21.0',
    });
    const cursorRuns = JSON.parse(
      await readFile(
        join(outputDirectory, 'conductor/cursor-runs.json'),
        'utf8',
      ),
    );

    expect(result.manifest.session.backend).toBe('cursor');
    expect(cursorRuns).toMatchObject({
      status: 'available',
      runs: expect.arrayContaining([
        expect.objectContaining({
          metadata: { ...fixture.metadata, id: 'cursor-run-0' },
          conversation: fixture.conversation,
          conversationStatus: 'available',
        }),
        expect.objectContaining({
          metadata: { ...fixture.metadata, id: 'cursor-run-100' },
          conversation: fixture.conversation,
          conversationStatus: 'available',
        }),
      ]),
    });
    expect(cursorRuns.runs).toHaveLength(101);
    expect(listRuns).toHaveBeenNthCalledWith(2, SESSION_ID, {
      runtime: 'local',
      cwd: conductorCwd,
      limit: 100,
      cursor: 'page-2',
    });
    expect(
      result.manifest.sources.find(
        (source) => source.id === 'conductor.cursorRuns',
      ),
    ).toMatchObject({
      status: 'available',
      bundlePaths: ['conductor/cursor-runs.json'],
    });
  });

  it('marks an empty Cursor run listing unavailable and keeps the export partial', async () => {
    await writeResumeStore({ backend: 'cursor' });
    listRuns.mockResolvedValue({ items: [] });
    const outputDirectory = join(tempRoot, 'empty-cursor-bundle');

    const result = await exportSessionBundle({
      repoRoot,
      conductorAgentId: SESSION_ID,
      outputDirectory,
      ensembleVersion: '0.21.0',
      cliVersion: '0.21.0',
    });
    const cursorRuns = JSON.parse(
      await readFile(
        join(outputDirectory, 'conductor/cursor-runs.json'),
        'utf8',
      ),
    );
    const warning = 'The Cursor provider session has no saved runs.';

    expect(cursorRuns).toEqual({
      status: 'unavailable',
      runs: [],
      warnings: [warning],
    });
    expect(result.status).toBe('partial');
    expect(result.warnings).toContain(warning);
    expect(result.manifest.warnings).toContain(warning);
    expect(result.manifest.sources).toContainEqual(
      expect.objectContaining({
        id: 'conductor.cursorRuns',
        status: 'unavailable',
        bundlePaths: ['conductor/cursor-runs.json'],
      }),
    );
  });

  it('marks an idle harness session as a partial best-effort snapshot', async () => {
    await writeResumeStore({ harnessPhase: 'idle' });

    const result = await exportSessionBundle({
      repoRoot,
      conductorAgentId: SESSION_ID,
      outputDirectory: join(tempRoot, 'idle-bundle'),
      ensembleVersion: '0.21.0',
      cliVersion: '0.21.0',
    });

    const warning =
      'この session の harness は稼働中です（phase: idle）。export は読み取り専用の best-effort snapshot で、複数ファイルが同じ時点の内容であることは保証しません。';
    expect(result.status).toBe('partial');
    expect(result.warnings).toContain(warning);
    expect(result.manifest.session.harnessPhase).toBe('idle');
    expect(result.manifest.warnings).toContain(warning);
  });

  it('records missing supplemental data and a running-session best-effort warning', async () => {
    await writeResumeStore({ harnessPhase: 'running' });
    await rm(paths.sessionStatePath(SESSION_ID));
    await rm(paths.openQuestionsPath(SESSION_ID));
    await rm(piTranscriptPath);
    await rm(paths.legacyPiSessionsDirForCwd(conductorCwd), {
      recursive: true,
    });

    const result = await exportSessionBundle({
      repoRoot,
      conductorAgentId: SESSION_ID,
      outputDirectory: join(tempRoot, 'partial-bundle'),
      ensembleVersion: '0.21.0',
      cliVersion: '0.21.0',
      includeToolCalls: true,
      summaryPath: join(tempRoot, 'missing-summary.json'),
      harnessLogPath: join(tempRoot, 'missing-harness.log'),
    });

    expect(result.status).toBe('partial');
    expect(result.warnings).toContain(
      'この session の harness は稼働中です（phase: running）。export は読み取り専用の best-effort snapshot で、複数ファイルが同じ時点の内容であることは保証しません。',
    );
    expect(result.manifest.sources).toContainEqual(
      expect.objectContaining({
        id: 'conductor.piTranscript',
        status: 'unavailable',
      }),
    );
    expect(result.manifest.sources).toContainEqual(
      expect.objectContaining({
        id: 'harness.sessionState',
        status: 'unavailable',
      }),
    );
    expect(result.manifest.sources).toContainEqual(
      expect.objectContaining({
        id: 'harness.toolCallSnapshots',
        status: 'unavailable',
      }),
    );
    expect(result.manifest.sources).toContainEqual(
      expect.objectContaining({
        id: 'input.summary',
        status: 'unavailable',
      }),
    );
    expect(result.manifest.sources).toContainEqual(
      expect.objectContaining({
        id: 'input.harnessLog',
        status: 'unavailable',
      }),
    );
  });

  it('refuses an existing output directory without changing its contents', async () => {
    const outputDirectory = join(tempRoot, 'existing-bundle');
    await mkdir(outputDirectory);
    const sentinelPath = join(outputDirectory, 'keep.txt');
    await writeFile(sentinelPath, 'keep me');

    await expect(
      exportSessionBundle({
        repoRoot,
        conductorAgentId: SESSION_ID,
        outputDirectory,
        ensembleVersion: '0.21.0',
        cliVersion: '0.21.0',
      }),
    ).rejects.toThrow('Output directory already exists');
    await expect(readFile(sentinelPath, 'utf8')).resolves.toBe('keep me');
  });

  it('fails before creating a bundle when the required SessionResumeStore is missing', async () => {
    await rm(resumeStorePath);
    const outputDirectory = join(tempRoot, 'missing-session-bundle');

    await expect(
      exportSessionBundle({
        repoRoot,
        conductorAgentId: SESSION_ID,
        outputDirectory,
        ensembleVersion: '0.21.0',
        cliVersion: '0.21.0',
      }),
    ).rejects.toThrow(`No saved session found for ${SESSION_ID}`);
    await expect(readFile(join(outputDirectory, 'manifest.json'))).rejects.toThrow();
  });

  it('does not follow symlink sources for optional inputs', async (context) => {
    const rawPath = join(tempRoot, 'raw-summary.json');
    const summaryPath = join(tempRoot, 'summary-link.json');
    await writeFile(rawPath, '{"secret":"DO_NOT_COPY"}\n');
    try {
      await symlink(rawPath, summaryPath);
    } catch (error) {
      if (
        process.platform === 'win32' &&
        isWindowsSymlinkPrivilegeError(error)
      ) {
        context.skip(
          'Windows symlink creation needs Developer Mode or an account with symlink privilege; enable it and rerun this test.',
        );
      }
      throw error;
    }

    const outputDirectory = join(tempRoot, 'symlink-bundle');
    const result = await exportSessionBundle({
      repoRoot,
      conductorAgentId: SESSION_ID,
      outputDirectory,
      ensembleVersion: '0.21.0',
      cliVersion: '0.21.0',
      summaryPath,
    });

    expect(
      result.manifest.sources.find((source) => source.id === 'input.summary'),
    ).toMatchObject({
      status: 'unavailable',
      sourcePaths: [summaryPath],
    });
    await expect(
      readFile(join(outputDirectory, 'inputs/session-summary.json')),
    ).rejects.toThrow();
    expect(
      await readFile(join(outputDirectory, 'manifest.json'), 'utf8'),
    ).not.toContain('DO_NOT_COPY');
  });

  async function writeResumeStore(options: {
    backend?: 'cursor' | 'pi';
    harnessPhase?: 'running' | 'idle' | 'close';
  } = {}): Promise<void> {
    const fixture = JSON.parse(
      await readFile(RESUME_STORE_FIXTURE, 'utf8'),
    ) as Record<string, unknown> & {
      workers: Record<string, { acpCwd: string }>;
    };
    fixture.repoRoot = repoRoot;
    fixture.conductorCwd = conductorCwd;
    fixture.conductorBackend = options.backend ?? 'pi';
    fixture.harnessPhase = options.harnessPhase ?? 'close';
    fixture.lifecycle =
      options.harnessPhase === 'close' || !options.harnessPhase
        ? 'closed'
        : 'unknown';
    fixture.rawFixtureSecret = 'api_key=raw-fixture-secret';
    fixture.workers.implementer!.acpCwd = CODEX_CWD;
    await mkdir(dirname(resumeStorePath), { recursive: true });
    await writeFile(
      resumeStorePath,
      `${JSON.stringify(fixture, null, 2)}\n`,
      'utf8',
    );
  }

  async function writeCodexWorkerRollout(
    additionalTurns = 0,
  ): Promise<void> {
    codexRolloutPath = join(
      codexHome,
      'sessions',
      '2026',
      '11',
      '09',
      `rollout-${CODEX_FILENAME_TIMESTAMP}-${CODEX_SESSION_ID}.jsonl`,
    );
    await mkdir(dirname(codexRolloutPath), { recursive: true });
    if (additionalTurns === 0) {
      await copyFile(CODEX_ROLLOUT_FIXTURE, codexRolloutPath);
      return;
    }

    const fixture = (await readFile(CODEX_ROLLOUT_FIXTURE, 'utf8')).trimEnd();
    const additionalMessages = Array.from(
      { length: additionalTurns * 2 },
      (_, index) => {
        const role = index % 2 === 0 ? 'user' : 'assistant';
        const turn = Math.floor(index / 2);
        return JSON.stringify({
          timestamp: '2026-11-09T14:04:00.000Z',
          ordinal: index + 6,
          type: 'response_item',
          payload: {
            type: 'message',
            role,
            content: [
              {
                type: role === 'user' ? 'input_text' : 'output_text',
                text: `unbounded-${turn}-${role}`,
              },
            ],
          },
        });
      },
    );
    await writeFile(
      codexRolloutPath,
      `${fixture}\n${additionalMessages.join('\n')}\n`,
      'utf8',
    );
  }

  async function writeSessionSnapshots(): Promise<void> {
    const sessionStatePath = paths.sessionStatePath(SESSION_ID);
    const openQuestionsPath = paths.openQuestionsPath(SESSION_ID);
    const toolCallsPath = paths.toolCallHistoryPath(SESSION_ID);
    await Promise.all([
      mkdir(dirname(sessionStatePath), { recursive: true }),
      mkdir(dirname(openQuestionsPath), { recursive: true }),
      mkdir(dirname(toolCallsPath), { recursive: true }),
    ]);
    await writeFile(sessionStatePath, 'current: raw status\n');
    await writeFile(openQuestionsPath, 'openQuestions: [raw question]\n');
  }

  function writePiConductorHistory(): string {
    const manager = SessionManager.create(
      conductorCwd,
      paths.piSessionsDir,
      { id: SESSION_ID },
    );
    for (let index = 0; index <= 100; index += 1) {
      appendPiTurn(manager, index);
    }
    const legacyManager = SessionManager.create(
      conductorCwd,
      paths.legacyPiSessionsDirForCwd(conductorCwd),
      { id: SESSION_ID },
    );
    appendPiTurn(legacyManager, 999, 'LEGACY_PI_TRANSCRIPT');
    return manager.getSessionFile();
  }
});

function appendPiTurn(
  manager: SessionManager,
  index: number,
  inbound = `turn-${String(index).padStart(3, '0')}-inbound`,
): void {
  const inboundEntryId = manager.appendMessage({
    role: 'user',
    content: [{ type: 'text', text: inbound }],
    timestamp: 1_800_000_000_000 + index * 3,
  });
  const responseEntryId = manager.appendMessage({
    role: 'assistant',
    content: [{ type: 'text', text: `turn-${index}-response` }],
    api: 'anthropic-messages',
    provider: 'anthropic',
    model: 'fixture-model',
    usage: {},
    stopReason: 'stop',
    timestamp: 1_800_000_000_001 + index * 3,
  });
  manager.appendCustomEntry(PI_CONDUCTOR_MESSAGE_HISTORY_ENTRY_TYPE, {
    inboundEntryId,
    responseEntryId,
    completedAt: 1_800_000_000_002 + index * 3,
    sendCount: index + 1,
    dispatchSource: 'operator',
  });
}

function isWindowsSymlinkPrivilegeError(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    ['EACCES', 'EPERM'].includes(
      (error as NodeJS.ErrnoException).code ?? '',
    )
  );
}
