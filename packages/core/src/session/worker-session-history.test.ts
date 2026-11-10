import {
  copyFile,
  mkdtemp,
  mkdir,
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

  it('returns unavailable when the Pi ACP map has no entry for the saved session', async () => {
    const result = await readHistory();

    expect(result).toMatchObject({
      preset: 'pi',
      status: 'unavailable',
      reason: expect.stringContaining('session map が見つかりません'),
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

  async function writePiAcpSessionMap(): Promise<void> {
    const transcriptPath = join(
      homeRoot,
      '.pi',
      'agent',
      'sessions',
      'pi-acp-worker-session.jsonl',
    );
    await mkdir(dirname(transcriptPath), { recursive: true });
    await copyFile(FIXTURE_PATH, transcriptPath);

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
              cwd: ACP_CWD,
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
  }
});
