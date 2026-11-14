import {
  mkdtemp,
  mkdir,
  readFile,
  rm,
  writeFile,
} from 'node:fs/promises';
import type { Transform } from 'node:stream';
import { tmpdir } from 'node:os';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from 'vitest';
import { resolveEnsemblePaths } from '../ensemble-paths.js';
import {
  saveSessionResumeStore,
  type SessionResumeStore,
} from './session-resume-store.js';
import {
  getWorkerSessionHistoryReaderSupport,
  readWorkerSessionHistory,
} from './worker-session-history.js';

const CONDUCTOR_AGENT_ID = 'worker-history-fixture';
const WORKER_NAME = 'implementer';
const ISSUE_NUMBER = 654;
const ACP_SESSION_ID = 'pi-acp-worker-fixture-session';
const ACP_CWD = '/tmp/pi-acp-worker-fixture';
const FIXTURE_PATH = fileURLToPath(
  new URL('../../test/fixtures/pi-acp-worker-session.jsonl', import.meta.url),
);
const CODEX_SESSION_ID = '019a4b21-9c0e-7a44-b9ad-6a8df4fa7720';
const CODEX_CWD = '/tmp/codex-acp-worker-fixture';
const CODEX_FILENAME_TIMESTAMP = '2026-11-09T14-03-00';
const CODEX_FIXTURE_PATH = fileURLToPath(
  new URL('../../test/fixtures/codex-cli-worker-rollout.jsonl', import.meta.url),
);

describe('worker session history', () => {
  let tempRoot = '';
  let repoRoot = '';
  let homeRoot = '';
  let userRoot = '';

  beforeEach(async () => {
    tempRoot = await mkdtemp(join(tmpdir(), 'ensemble-worker-history-'));
    repoRoot = join(tempRoot, 'repository');
    homeRoot = join(tempRoot, 'home');
    userRoot = join(tempRoot, 'user-ensemble');
    await mkdir(repoRoot, { recursive: true });
    await mkdir(homeRoot, { recursive: true });
    vi.stubEnv('HOME', homeRoot);
    vi.stubEnv('ENSEMBLE_USER_ROOT', userRoot);
    vi.stubEnv('CODEX_HOME', '');
    await writeResumeStore('pi');
  });

  afterEach(async () => {
    vi.unstubAllEnvs();
    if (tempRoot) await rm(tempRoot, { recursive: true, force: true });
    tempRoot = '';
    repoRoot = '';
    homeRoot = '';
    userRoot = '';
  });

  it('registers Pi as supported and reports other or missing presets', () => {
    expect(getWorkerSessionHistoryReaderSupport('pi')).toEqual({
      preset: 'pi',
      status: 'supported',
      reader: 'pi-acp-jsonl',
    });
    expect(getWorkerSessionHistoryReaderSupport('codex')).toEqual({
      preset: 'codex',
      status: 'supported',
      reader: 'codex-cli-rollout-jsonl',
    });
    expect(getWorkerSessionHistoryReaderSupport(undefined)).toMatchObject({
      preset: null,
      status: 'unsupported',
      reason: expect.stringContaining('preset がない'),
    });
  });

  it('reads user and assistant text from a Codex CLI rollout only', async () => {
    await writeResumeStore('codex', {
      acpSessionId: CODEX_SESSION_ID,
      acpCwd: CODEX_CWD,
    });
    await writeCodexAcpRollout();

    const result = await readHistory();

    expect(result).toMatchObject({
      conductorAgentId: CONDUCTOR_AGENT_ID,
      worker: WORKER_NAME,
      preset: 'codex',
      status: 'supported',
      reader: 'codex-cli-rollout-jsonl',
      messages: [
        {
          source: 'worker:implementer',
          providerId: 'codex:2',
          role: 'user',
          at: Date.parse('2026-11-09T14:03:01.001Z'),
          text: 'Codex ACP fixture user message.',
        },
        {
          source: 'worker:implementer',
          providerId: 'codex:5',
          role: 'assistant',
          at: Date.parse('2026-11-09T14:03:03.000Z'),
          text: 'Codex ACP fixture assistant reply.',
        },
      ],
    });
    for (const hiddenContent of [
      'This display event is not the canonical transcript message.',
      'IMAGE_SECRET',
      'REASONING_SECRET',
      'TOOL_SECRET',
      'REFUSAL_SECRET',
    ]) {
      expect(JSON.stringify(result)).not.toContain(hiddenContent);
    }
  });

  it('returns unavailable when the Codex rollout is missing', async () => {
    await writeResumeStore('codex', {
      acpSessionId: CODEX_SESSION_ID,
      acpCwd: CODEX_CWD,
    });

    const result = await readHistory();

    expect(result).toMatchObject({
      preset: 'codex',
      status: 'unavailable',
      reason: expect.stringContaining('rollout が見つかりません'),
      messages: [],
    });
  });

  it('returns unavailable when the Codex rollout contains malformed JSONL', async () => {
    await writeResumeStore('codex', {
      acpSessionId: CODEX_SESSION_ID,
      acpCwd: CODEX_CWD,
    });
    await writeCodexAcpRollout({
      content: '{"timestamp":"2026-11-09T14:03:00.000Z","type":"session_meta"',
    });

    const result = await readHistory();

    expect(result).toMatchObject({
      status: 'unavailable',
      reason: expect.stringContaining('不正な行'),
      messages: [],
    });
  });

  it('returns unavailable when the Codex rollout session ID differs', async () => {
    await writeResumeStore('codex', {
      acpSessionId: CODEX_SESSION_ID,
      acpCwd: CODEX_CWD,
    });
    const fixture = await readFile(CODEX_FIXTURE_PATH, 'utf8');
    const mismatchedFixture = fixture.replace(
      `"id":"${CODEX_SESSION_ID}"`,
      '"id":"019a4b21-9c0e-7a44-b9ad-6a8df4fa7721"',
    );
    await writeCodexAcpRollout({ content: mismatchedFixture });

    const result = await readHistory();

    expect(result).toMatchObject({
      status: 'unavailable',
      reason: expect.stringContaining('session ID が保存状態と一致しません'),
      messages: [],
    });
  });

  it('returns unavailable when the Codex rollout cwd differs', async () => {
    await writeResumeStore('codex', {
      acpSessionId: CODEX_SESSION_ID,
      acpCwd: CODEX_CWD,
    });
    const fixture = await readFile(CODEX_FIXTURE_PATH, 'utf8');
    await writeCodexAcpRollout({
      content: fixture.replaceAll(CODEX_CWD, '/tmp/codex-acp-other-cwd'),
    });

    const result = await readHistory();

    expect(result).toMatchObject({
      status: 'unavailable',
      reason: expect.stringContaining('cwd が保存状態と一致しません'),
      messages: [],
    });
  });

  it('returns unavailable when active and archived Codex rollouts are ambiguous', async () => {
    await writeResumeStore('codex', {
      acpSessionId: CODEX_SESSION_ID,
      acpCwd: CODEX_CWD,
    });
    await writeCodexAcpRollout();
    await writeCodexAcpRollout({
      archived: true,
      fileName: `rollout-${CODEX_FILENAME_TIMESTAMP}-${CODEX_SESSION_ID}_019a4b21-9c0e-7a44-b9ad-6a8df4fa7721.jsonl`,
    });

    const result = await readHistory();

    expect(result).toMatchObject({
      status: 'unavailable',
      reason: expect.stringContaining('rollout が複数'),
      messages: [],
    });
  });

  it('reads an archived Codex revert rollout by its thread ID', async () => {
    await writeResumeStore('codex', {
      acpSessionId: CODEX_SESSION_ID,
      acpCwd: CODEX_CWD,
    });
    await writeCodexAcpRollout({
      archived: true,
      fileName: `rollout-${CODEX_FILENAME_TIMESTAMP}-${CODEX_SESSION_ID}_019a4b21-9c0e-7a44-b9ad-6a8df4fa7721.jsonl`,
    });

    const result = await readHistory();

    expect(result).toMatchObject({
      status: 'supported',
      messages: [
        { role: 'user', text: 'Codex ACP fixture user message.' },
        { role: 'assistant', text: 'Codex ACP fixture assistant reply.' },
      ],
    });
  });

  it('prefers the plain Codex rollout over a compressed sibling', async () => {
    await writeResumeStore('codex', {
      acpSessionId: CODEX_SESSION_ID,
      acpCwd: CODEX_CWD,
    });
    await writeCodexAcpRollout();
    const fixture = await readFile(CODEX_FIXTURE_PATH, 'utf8');
    await writeCodexAcpRollout({
      compressed: true,
      content: fixture.replace(
        'Codex ACP fixture user message.',
        'Compressed sibling must not win.',
      ),
    });

    const result = await readHistory();

    expect(result).toMatchObject({
      status: 'supported',
      messages: [
        { role: 'user', text: 'Codex ACP fixture user message.' },
        { role: 'assistant', text: 'Codex ACP fixture assistant reply.' },
      ],
    });
  });

  it('resolves absolute and relative CODEX_HOME values from the correct cwd', async () => {
    const workerCwd = join(tempRoot, 'worker-cwd');
    const cliCwd = process.cwd();
    const customCodexHome = join(tempRoot, 'custom-codex-home');

    await mkdir(workerCwd, { recursive: true });
    await writeResumeStore('codex', {
      acpSessionId: CODEX_SESSION_ID,
      acpCwd: workerCwd,
    });

    vi.stubEnv('CODEX_HOME', customCodexHome);
    const fixture = await readFile(CODEX_FIXTURE_PATH, 'utf8');
    await writeCodexAcpRollout({
      codexHome: customCodexHome,
      content: fixture.replaceAll(CODEX_CWD, workerCwd),
    });

    const configuredHomeResult = await readHistory();
    expect(configuredHomeResult.status).toBe('supported');

    const relativeCodexHome = relative(workerCwd, customCodexHome);
    expect(resolve(workerCwd, relativeCodexHome)).toBe(customCodexHome);
    expect(resolve(cliCwd, relativeCodexHome)).not.toBe(customCodexHome);
    vi.stubEnv('CODEX_HOME', relativeCodexHome);
    const relativeHomeResult = await readHistory();
    expect(relativeHomeResult).toMatchObject({
      status: 'supported',
      messages: [
        { role: 'user', text: 'Codex ACP fixture user message.' },
        { role: 'assistant', text: 'Codex ACP fixture assistant reply.' },
      ],
    });
  });

  it('reads compressed Codex rollouts when Node supports zstd', async () => {
    await writeResumeStore('codex', {
      acpSessionId: CODEX_SESSION_ID,
      acpCwd: CODEX_CWD,
    });
    const zlib = await import('node:zlib');
    const createZstdDecompress = (
      zlib as unknown as {
        createZstdDecompress?: () => Transform;
      }
    ).createZstdDecompress;
    const compressedPath = await writeCodexAcpRollout({ compressed: true });

    const result = await readHistory();

    if (!createZstdDecompress) {
      expect(result).toMatchObject({
        status: 'unavailable',
        reason: expect.stringContaining('zstd に対応していません'),
        messages: [],
      });
      return;
    }
    expect(compressedPath).toMatch(/\.jsonl\.zst$/u);
    expect(result).toMatchObject({
      status: 'supported',
      messages: [
        { role: 'user', text: 'Codex ACP fixture user message.' },
        { role: 'assistant', text: 'Codex ACP fixture assistant reply.' },
      ],
    });
  });

  it('reads user and assistant text from the active Pi branch only', async () => {
    const transcriptPath = await writePiAcpSessionMap();

    const result = await readHistory({ includeSourceFiles: true });

    expect(result).toMatchObject({
      conductorAgentId: CONDUCTOR_AGENT_ID,
      worker: WORKER_NAME,
      preset: 'pi',
      status: 'supported',
      reader: 'pi-acp-jsonl',
      messages: [
        {
          source: 'worker:implementer',
          providerId: 'root-user',
          role: 'user',
          at: 1_800_000_000_000,
          text: 'Earlier worker request remains on the active branch.',
        },
        {
          source: 'worker:implementer',
          providerId: 'current-user',
          role: 'user',
          at: 1_800_000_000_002,
          text: 'Pi ACP fixture user message.',
        },
        {
          source: 'worker:implementer',
          providerId: 'current-assistant',
          role: 'assistant',
          at: 1_800_000_000_005,
          text: 'Pi ACP fixture assistant reply.',
        },
      ],
      sourceFiles: [transcriptPath],
    });
    expect(JSON.stringify(result)).not.toContain('Abandoned branch');
    expect(JSON.stringify(result)).not.toContain('TOOL_SECRET');
    expect(JSON.stringify(result)).not.toContain('THINKING_SECRET');
  });

  it('reads builtin Pi transcripts from the repo and worker scoped user path', async () => {
    const transcriptPath = await writePiAcpSessionMap({ runtime: 'builtin' });

    const result = await readHistory({ includeSourceFiles: true });

    expect(result).toMatchObject({
      preset: 'pi',
      status: 'supported',
      reader: 'pi-acp-jsonl',
      messages: [
        { role: 'user', text: 'Earlier worker request remains on the active branch.' },
        { role: 'user', text: 'Pi ACP fixture user message.' },
        { role: 'assistant', text: 'Pi ACP fixture assistant reply.' },
      ],
      sourceFiles: [transcriptPath],
    });
    expect(transcriptPath).toBe(
      join(
        resolveEnsemblePaths({ repoRoot }).piWorkerSessionsDir(
          WORKER_NAME,
          ISSUE_NUMBER,
        ),
        'pi-acp-worker-session.jsonl',
      ),
    );
  });

  it('reads builtin Pi worker history from the saved clone path-hash', async () => {
    const savedRepoRoot = join(tempRoot, 'saved-clone');
    await mkdir(savedRepoRoot, { recursive: true });
    const transcriptPath = await writePiAcpSessionMap({
      runtime: 'builtin',
      repoRoot: savedRepoRoot,
    });

    const result = await readHistory({ includeSourceFiles: true });

    expect(result).toMatchObject({
      status: 'supported',
      messages: [
        { role: 'user', text: 'Earlier worker request remains on the active branch.' },
        { role: 'user', text: 'Pi ACP fixture user message.' },
        { role: 'assistant', text: 'Pi ACP fixture assistant reply.' },
      ],
      sourceFiles: [transcriptPath],
    });
  });

  it('reads same-named builtin workers from their separate Issue maps', async () => {
    const issueOne = 654;
    const issueTwo = 655;
    const sessionOne = 'pi-issue-654-session';
    const sessionTwo = 'pi-issue-655-session';
    const conductorOne = 'worker-history-issue-654';
    const conductorTwo = 'worker-history-issue-655';
    const cwdOne = join(tempRoot, 'issue-654-worktree');
    const cwdTwo = join(tempRoot, 'issue-655-worktree');

    const [transcriptOne, transcriptTwo] = await Promise.all([
      writePiAcpSessionMap({
        runtime: 'builtin',
        issueNumber: issueOne,
        conductorAgentId: conductorOne,
        acpCwd: cwdOne,
        sessionId: sessionOne,
        messageText: 'Issue 654 worker conversation.',
      }),
      writePiAcpSessionMap({
        runtime: 'builtin',
        issueNumber: issueTwo,
        conductorAgentId: conductorTwo,
        acpCwd: cwdTwo,
        sessionId: sessionTwo,
        messageText: 'Issue 655 worker conversation.',
      }),
    ]);

    const [historyOne, historyTwo] = await Promise.all([
      readHistory({
        conductorAgentId: conductorOne,
        includeSourceFiles: true,
      }),
      readHistory({
        conductorAgentId: conductorTwo,
        includeSourceFiles: true,
      }),
    ]);

    expect(historyOne).toMatchObject({
      status: 'supported',
      messages: [
        { role: 'user', text: 'Earlier worker request remains on the active branch.' },
        { role: 'user', text: 'Issue 654 worker conversation.' },
        { role: 'assistant', text: 'Pi ACP fixture assistant reply.' },
      ],
      sourceFiles: [transcriptOne],
    });
    expect(historyTwo).toMatchObject({
      status: 'supported',
      messages: [
        { role: 'user', text: 'Earlier worker request remains on the active branch.' },
        { role: 'user', text: 'Issue 655 worker conversation.' },
        { role: 'assistant', text: 'Pi ACP fixture assistant reply.' },
      ],
      sourceFiles: [transcriptTwo],
    });
    expect(transcriptOne).not.toBe(transcriptTwo);

    const paths = resolveEnsemblePaths({ repoRoot });
    const mapOne = JSON.parse(
      await readFile(
        paths.piWorkerSessionMapPath(WORKER_NAME, issueOne),
        'utf8',
      ),
    ) as { sessions: Record<string, unknown> };
    const mapTwo = JSON.parse(
      await readFile(
        paths.piWorkerSessionMapPath(WORKER_NAME, issueTwo),
        'utf8',
      ),
    ) as { sessions: Record<string, unknown> };
    expect(Object.keys(mapOne.sessions)).toEqual([sessionOne]);
    expect(Object.keys(mapTwo.sessions)).toEqual([sessionTwo]);
  });

  it('does not guess a builtin Pi transcript when its map is missing', async () => {
    const transcriptPath = await writePiAcpSessionMap({ runtime: 'builtin' });
    const paths = resolveEnsemblePaths({ repoRoot });
    await rm(
      paths.piWorkerSessionMapPath(WORKER_NAME, ISSUE_NUMBER),
      { force: true },
    );

    const result = await readHistory();

    expect(result).toMatchObject({
      preset: 'pi',
      status: 'unavailable',
      reason: expect.stringContaining('session map が見つかりません'),
      messages: [],
    });
    await expect(readFile(transcriptPath, 'utf8')).resolves.toContain(
      'Pi ACP fixture user message.',
    );
  });

  it('reads a legacy builtin session map before the wrapper migrates it', async () => {
    const transcriptPath = await writePiAcpSessionMap({
      runtime: 'builtin',
      legacyMap: true,
    });

    const result = await readHistory({ includeSourceFiles: true });

    expect(result).toMatchObject({
      preset: 'pi',
      status: 'supported',
      reader: 'pi-acp-jsonl',
      messages: [
        { role: 'user', text: 'Earlier worker request remains on the active branch.' },
        { role: 'user', text: 'Pi ACP fixture user message.' },
        { role: 'assistant', text: 'Pi ACP fixture assistant reply.' },
      ],
      sourceFiles: [transcriptPath],
    });
    expect(transcriptPath).toBe(
      join(
        resolveEnsemblePaths({ repoRoot }).piWorkerSessionsDir(
          WORKER_NAME,
          ISSUE_NUMBER,
        ),
        'pi-acp-worker-session.jsonl',
      ),
    );
  });

  it('reads a pre-Issue builtin map and transcript before wrapper migration', async () => {
    const sessionId = 'pre-issue-builtin-session';
    const conductorAgentId = 'worker-history-pre-issue';
    const legacyHome = resolveEnsemblePaths({
      repoRoot,
    }).legacyPiWorkerDir(WORKER_NAME);
    const transcriptPath = join(
      legacyHome,
      'sessions',
      `${sessionId}.jsonl`,
    );
    const mapPath = join(
      legacyHome,
      '.pi',
      'pi-acp',
      'session-map.json',
    );
    await writeResumeStore('pi', {
      piRuntime: 'builtin',
      issueNumber: ISSUE_NUMBER,
      conductorAgentId,
      acpSessionId: sessionId,
      acpCwd: ACP_CWD,
    });
    await mkdir(dirname(transcriptPath), { recursive: true });
    const fixture = await readFile(FIXTURE_PATH, 'utf8');
    await writeFile(
      transcriptPath,
      fixture.replaceAll(ACP_SESSION_ID, sessionId),
      'utf8',
    );
    await mkdir(dirname(mapPath), { recursive: true });
    await writeFile(
      mapPath,
      JSON.stringify({
        version: 1,
        sessions: {
          [sessionId]: {
            sessionId,
            cwd: ACP_CWD,
            sessionFile: transcriptPath,
          },
        },
      }),
    );

    const result = await readHistory({
      conductorAgentId,
      includeSourceFiles: true,
    });

    expect(result).toMatchObject({
      status: 'supported',
      messages: [
        { role: 'user', text: 'Earlier worker request remains on the active branch.' },
        { role: 'user', text: 'Pi ACP fixture user message.' },
        { role: 'assistant', text: 'Pi ACP fixture assistant reply.' },
      ],
      sourceFiles: [transcriptPath],
    });
  });

  it('does not change an empty Pi transcript while reading it', async () => {
    const transcriptPath = await writePiAcpSessionMap({
      transcriptContent: '',
    });
    const before = await readFile(transcriptPath, 'utf8');

    const result = await readHistory();

    expect(result).toMatchObject({
      status: 'unavailable',
      reason: expect.stringContaining('session header'),
      messages: [],
    });
    expect(await readFile(transcriptPath, 'utf8')).toBe(before);
  });

  it('reads a legacy Pi v1 transcript in memory without rewriting it', async () => {
    const legacyTranscript = [
      JSON.stringify({
        type: 'session',
        version: 1,
        id: ACP_SESSION_ID,
        timestamp: '2027-01-15T08:00:00.000Z',
        cwd: ACP_CWD,
      }),
      JSON.stringify({
        type: 'message',
        timestamp: '2027-01-15T08:00:01.000Z',
        message: {
          role: 'user',
          content: 'Legacy Pi user message.',
          timestamp: 1_800_000_000_001,
        },
      }),
      JSON.stringify({
        type: 'message',
        timestamp: '2027-01-15T08:00:02.000Z',
        message: {
          role: 'assistant',
          content: 'Legacy Pi assistant reply.',
          timestamp: 1_800_000_000_002,
        },
      }),
    ].join('\n');
    const transcriptPath = await writePiAcpSessionMap({
      transcriptContent: legacyTranscript,
    });

    const result = await readHistory();

    expect(result).toMatchObject({
      status: 'supported',
      messages: [
        { role: 'user', text: 'Legacy Pi user message.' },
        { role: 'assistant', text: 'Legacy Pi assistant reply.' },
      ],
    });
    expect(await readFile(transcriptPath, 'utf8')).toBe(legacyTranscript);
  });

  it('rejects a transcript whose header cwd differs from the saved cwd', async () => {
    const fixture = await readFile(FIXTURE_PATH, 'utf8');
    const [headerLine, ...remainingLines] = fixture.split('\n');
    const transcriptHeader = JSON.parse(headerLine ?? '') as {
      cwd: string;
    };
    const transcript = [
      JSON.stringify({
        ...transcriptHeader,
        cwd: '/tmp/pi-acp-different-cwd',
      }),
      ...remainingLines,
    ].join('\n');
    const transcriptPath = await writePiAcpSessionMap({
      transcriptContent: transcript,
    });

    const result = await readHistory();

    expect(result).toMatchObject({
      status: 'unavailable',
      reason: expect.stringContaining('transcript header の cwd'),
      messages: [],
    });
    expect(await readFile(transcriptPath, 'utf8')).toBe(transcript);
  });

  it('returns unavailable for a malformed Pi transcript header', async () => {
    const transcriptPath = await writePiAcpSessionMap({
      transcriptContent: 'not json\n',
    });
    const before = await readFile(transcriptPath, 'utf8');

    const result = await readHistory();

    expect(result).toMatchObject({
      status: 'unavailable',
      reason: expect.stringContaining('有効な session header'),
      messages: [],
    });
    expect(await readFile(transcriptPath, 'utf8')).toBe(before);
  });

  it('returns unavailable when the Pi ACP map has no entry for the saved session', async () => {
    const result = await readHistory();

    expect(result).toMatchObject({
      preset: 'pi',
      status: 'unavailable',
      reason: expect.stringContaining('session map が見つかりません'),
      messages: [],
    });
  });

  it('returns unavailable when the Pi ACP map cwd differs from the saved cwd', async () => {
    await writePiAcpSessionMap({ mapCwd: '/tmp/pi-acp-other-map-cwd' });

    const result = await readHistory();

    expect(result).toMatchObject({
      status: 'unavailable',
      reason: expect.stringContaining('session map の cwd'),
      messages: [],
    });
  });

  it('returns unavailable when the Pi ACP map points to a missing transcript', async () => {
    await writePiAcpSessionMap({ writeTranscript: false });

    const result = await readHistory();

    expect(result).toMatchObject({
      status: 'unavailable',
      reason: expect.stringContaining('transcript file が見つかりません'),
      messages: [],
    });
  });

  it('returns unsupported when an older or unsupported preset is saved', async () => {
    await writeResumeStore(undefined);
    const missingPreset = await readHistory();
    expect(missingPreset).toMatchObject({
      preset: null,
      status: 'unsupported',
      reason: expect.stringContaining('preset がない'),
      messages: [],
    });

    await writeResumeStore('custom');
    const customPreset = await readHistory();
    expect(customPreset).toMatchObject({
      preset: 'custom',
      status: 'unsupported',
      reason: expect.stringContaining('custom'),
      messages: [],
    });
  });

  async function readHistory(
    options: {
      conductorAgentId?: string;
      githubRepo?: string;
      includeSourceFiles?: boolean;
      workerName?: string;
    } = {},
  ) {
    return readWorkerSessionHistory({
      repoRoot,
      conductorAgentId: options.conductorAgentId ?? CONDUCTOR_AGENT_ID,
      workerName: options.workerName ?? WORKER_NAME,
      githubRepo: 'otolab/agents-ensemble',
      ...options,
    });
  }

  async function writeResumeStore(
    preset: 'pi' | 'codex' | 'custom' | undefined,
    workerSession: {
      acpSessionId?: string;
      acpCwd?: string;
      conductorAgentId?: string;
      issueNumber?: number;
      piRuntime?: 'builtin';
      repoRoot?: string;
      workerName?: string;
    } = {},
  ): Promise<void> {
    const conductorAgentId =
      workerSession.conductorAgentId ?? CONDUCTOR_AGENT_ID;
    const issueNumber = workerSession.issueNumber ?? ISSUE_NUMBER;
    const workerName = workerSession.workerName ?? WORKER_NAME;
    const resumeStore: SessionResumeStore = {
      version: 1,
      conductorAgentId,
      issueUrl: `https://github.com/otolab/agents-ensemble/issues/${issueNumber}`,
      repoRoot: workerSession.repoRoot ?? repoRoot,
      profile: {
        workers: [{ name: workerName, kind: 'implementer' }],
      },
      openQuestions: [],
      sequence: 0,
      workers: {
        [workerName]: {
          acpSessionId: workerSession.acpSessionId ?? ACP_SESSION_ID,
          acpCwd: workerSession.acpCwd ?? ACP_CWD,
          ...(preset
            ? {
                acpSpawn: {
                  preset,
                  command:
                    preset === 'pi'
                      ? 'pi-acp'
                      : preset === 'codex'
                        ? 'codex-acp'
                        : 'fixture-acp',
                  args: [],
                  ...(workerSession.piRuntime
                    ? { piRuntime: workerSession.piRuntime }
                    : {}),
                },
              }
            : {}),
        },
      },
      updatedAt: 1_800_000_000_000,
    };
    const paths = resolveEnsemblePaths({ repoRoot, userEnsembleRoot: userRoot });
    const path = workerSession.repoRoot
      ? paths.canonicalSessionResumeStorePath(
          `https://github.com/otolab/agents-ensemble/issues/${issueNumber}`,
          conductorAgentId,
        )
      : paths.sessionResumeStorePath(conductorAgentId);
    await mkdir(dirname(path), { recursive: true });
    await saveSessionResumeStore(path, resumeStore);
  }

  async function writeCodexAcpRollout(
    options: {
      codexHome?: string;
      archived?: boolean;
      fileName?: string;
      content?: string;
      compressed?: boolean;
    } = {},
  ): Promise<string> {
    const codexHome = options.codexHome ?? join(homeRoot, '.codex');
    const fileName =
      options.fileName ??
      `rollout-${CODEX_FILENAME_TIMESTAMP}-${CODEX_SESSION_ID}${
        options.compressed ? '.jsonl.zst' : '.jsonl'
      }`;
    const rolloutPath = join(
      codexHome,
      options.archived ? 'archived_sessions' : 'sessions',
      ...(options.archived ? [] : ['2026', '11', '09']),
      fileName,
    );
    await mkdir(dirname(rolloutPath), { recursive: true });

    const content =
      options.content ?? (await readFile(CODEX_FIXTURE_PATH, 'utf8'));
    await writeFile(
      rolloutPath,
      options.compressed ? await compressZstd(content) : content,
    );
    return rolloutPath;
  }

  async function compressZstd(content: string): Promise<Buffer> {
    const zlib = await import('node:zlib');
    const createZstdCompress = (
      zlib as unknown as {
        createZstdCompress?: () => Transform;
      }
    ).createZstdCompress;
    if (!createZstdCompress) return Buffer.from(content);

    const compressor = createZstdCompress();
    const chunks: Buffer[] = [];
    const compressed = new Promise<Buffer>((resolve, reject) => {
      compressor.on('data', (chunk: Buffer) => chunks.push(Buffer.from(chunk)));
      compressor.once('error', reject);
      compressor.once('end', () => resolve(Buffer.concat(chunks)));
    });
    compressor.end(content);
    return compressed;
  }

  async function writePiAcpSessionMap(
    options: {
      acpCwd?: string;
      conductorAgentId?: string;
      issueNumber?: number;
      messageText?: string;
      mapCwd?: string;
      sessionId?: string;
      transcriptContent?: string;
      writeTranscript?: boolean;
      runtime?: 'builtin';
      legacyMap?: boolean;
      repoRoot?: string;
    } = {},
  ): Promise<string> {
    const issueNumber = options.issueNumber ?? ISSUE_NUMBER;
    const conductorAgentId =
      options.conductorAgentId ?? CONDUCTOR_AGENT_ID;
    const sessionId = options.sessionId ?? ACP_SESSION_ID;
    const acpCwd = options.acpCwd ?? ACP_CWD;
    if (options.runtime === 'builtin') {
      await writeResumeStore('pi', {
        conductorAgentId,
        issueNumber,
        acpSessionId: sessionId,
        acpCwd,
        piRuntime: 'builtin',
        ...(options.repoRoot ? { repoRoot: options.repoRoot } : {}),
      });
    }
    const paths = resolveEnsemblePaths({
      repoRoot: options.repoRoot ?? repoRoot,
    });
    const transcriptPath =
      options.runtime === 'builtin'
        ? join(
            paths.piWorkerSessionsDir(WORKER_NAME, issueNumber),
            options.sessionId
              ? `${sessionId}.jsonl`
              : 'pi-acp-worker-session.jsonl',
          )
        : join(
            homeRoot,
            '.pi',
            'agent',
            'sessions',
            'pi-acp-worker-session.jsonl',
          );
    if (options.writeTranscript !== false) {
      await mkdir(dirname(transcriptPath), { recursive: true });
      if (options.transcriptContent === undefined) {
        const fixture = await readFile(FIXTURE_PATH, 'utf8');
        await writeFile(
          transcriptPath,
          fixture
            .replaceAll(ACP_SESSION_ID, sessionId)
            .replaceAll(ACP_CWD, acpCwd)
            .replace(
              'Pi ACP fixture user message.',
              options.messageText ?? 'Pi ACP fixture user message.',
            ),
          'utf8',
        );
      } else {
        await writeFile(transcriptPath, options.transcriptContent, 'utf8');
      }
    }

    const mapPath =
      options.runtime === 'builtin'
        ? options.legacyMap
          ? join(
              paths.piWorkerDir(WORKER_NAME, issueNumber),
              'session-map.json',
            )
          : paths.piWorkerSessionMapPath(WORKER_NAME, issueNumber)
        : join(homeRoot, '.pi', 'pi-acp', 'session-map.json');
    await mkdir(dirname(mapPath), { recursive: true });
    await writeFile(
      mapPath,
      `${JSON.stringify(
        {
          version: 1,
          sessions: {
            [sessionId]: {
              sessionId,
              cwd: options.mapCwd ?? acpCwd,
              sessionFile: transcriptPath,
              updatedAt: '2027-01-15T08:00:00.000Z',
            },
          },
        },
        null,
        2,
      )}\n`,
      'utf8',
    );
    return transcriptPath;
  }
});
