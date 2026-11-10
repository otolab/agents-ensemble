import {
  copyFile,
  mkdtemp,
  mkdir,
  readFile,
  rm,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
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
const ACP_SESSION_ID = 'pi-acp-worker-fixture-session';
const ACP_CWD = '/tmp/pi-acp-worker-fixture';
const FIXTURE_PATH = fileURLToPath(
  new URL('../../test/fixtures/pi-acp-worker-session.jsonl', import.meta.url),
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
    expect(getWorkerSessionHistoryReaderSupport('codex')).toMatchObject({
      preset: 'codex',
      status: 'unsupported',
      reason: expect.stringContaining('未対応'),
    });
    expect(getWorkerSessionHistoryReaderSupport(undefined)).toMatchObject({
      preset: null,
      status: 'unsupported',
      reason: expect.stringContaining('preset がない'),
    });
  });

  it('reads user and assistant text from the active Pi branch only', async () => {
    await writePiAcpSessionMap();

    const result = await readHistory();

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
    });
    expect(JSON.stringify(result)).not.toContain('Abandoned branch');
    expect(JSON.stringify(result)).not.toContain('TOOL_SECRET');
    expect(JSON.stringify(result)).not.toContain('THINKING_SECRET');
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

  async function readHistory() {
    return readWorkerSessionHistory({
      repoRoot,
      conductorAgentId: CONDUCTOR_AGENT_ID,
      workerName: WORKER_NAME,
    });
  }

  async function writeResumeStore(
    preset: 'pi' | 'custom' | undefined,
  ): Promise<void> {
    const resumeStore: SessionResumeStore = {
      version: 1,
      conductorAgentId: CONDUCTOR_AGENT_ID,
      issueUrl: 'https://github.com/otolab/agents-ensemble/issues/654',
      repoRoot,
      profile: {
        workers: [{ name: WORKER_NAME, kind: 'implementer' }],
      },
      openQuestions: [],
      sequence: 0,
      workers: {
        [WORKER_NAME]: {
          acpSessionId: ACP_SESSION_ID,
          acpCwd: ACP_CWD,
          ...(preset
            ? {
                acpSpawn: {
                  preset,
                  command: 'pi-acp',
                  args: [],
                },
              }
            : {}),
        },
      },
      updatedAt: 1_800_000_000_000,
    };
    const path = resolveEnsemblePaths({ repoRoot }).sessionResumeStorePath(
      CONDUCTOR_AGENT_ID,
    );
    await mkdir(dirname(path), { recursive: true });
    await saveSessionResumeStore(path, resumeStore);
  }

  async function writePiAcpSessionMap(
    options: {
      mapCwd?: string;
      transcriptContent?: string;
      writeTranscript?: boolean;
    } = {},
  ): Promise<string> {
    const transcriptPath = join(
      homeRoot,
      '.pi',
      'agent',
      'sessions',
      'pi-acp-worker-session.jsonl',
    );
    if (options.writeTranscript !== false) {
      await mkdir(dirname(transcriptPath), { recursive: true });
      if (options.transcriptContent === undefined) {
        await copyFile(FIXTURE_PATH, transcriptPath);
      } else {
        await writeFile(transcriptPath, options.transcriptContent, 'utf8');
      }
    }

    const mapPath = join(homeRoot, '.pi', 'pi-acp', 'session-map.json');
    await mkdir(dirname(mapPath), { recursive: true });
    await writeFile(
      mapPath,
      `${JSON.stringify(
        {
          version: 1,
          sessions: {
            [ACP_SESSION_ID]: {
              sessionId: ACP_SESSION_ID,
              cwd: options.mapCwd ?? ACP_CWD,
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
