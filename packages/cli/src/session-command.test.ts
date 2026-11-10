import {
  copyFile,
  mkdir,
  mkdtemp,
  rm,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
} from 'vitest';
import { resolveEnsemblePaths } from '@agents-ensemble/core/operator-runtime';

const PI_SESSION_ROOT = '.ensemble/pi/sessions';
const PI_HISTORY_ENTRY_TYPE = 'agents-ensemble/conductor-message-history/v1';
const ISSUE_URL = 'https://github.com/otolab/agents-ensemble/issues/653';
const WORKER_PI_SESSION_ID = 'pi-acp-worker-fixture-session';
const WORKER_PI_CWD = '/tmp/pi-acp-worker-fixture';

describe('ensemble session commands', () => {
  let tempRoot = '';
  let repoRoot = '';
  let userRoot = '';
  let homeRoot = '';
  let conductorAgentId = '';
  let conductorCwd = '';

  beforeEach(async () => {
    tempRoot = await mkdtemp(join(tmpdir(), 'ensemble-session-cli-'));
    repoRoot = join(tempRoot, 'repository');
    userRoot = join(tempRoot, 'user-ensemble');
    homeRoot = join(tempRoot, 'home');
    conductorAgentId = 'session-fixture-653';
    conductorCwd = join(tempRoot, 'conductor');
    await mkdir(repoRoot, { recursive: true });
    await mkdir(homeRoot, { recursive: true });
    await mkdir(conductorCwd, { recursive: true });
    await writeResumeStore();
    await writeRelatedYaml();
    await writePiHistory();
  });

  afterEach(async () => {
    if (tempRoot) await rm(tempRoot, { recursive: true, force: true });
    tempRoot = '';
    repoRoot = '';
    userRoot = '';
    homeRoot = '';
    conductorCwd = '';
  });

  it('registers list, show, and messages as read-only CLI commands', () => {
    const result = runCli(['session', '--help']);

    expect(result.status).toBe(0);
    expect(result.stdout).toContain('list');
    expect(result.stdout).toContain('show');
    expect(result.stdout).toContain('messages');
    expect(result.stdout).toContain('workers');
    expect(result.stdout).toContain('without starting an agent');
  });

  it('warns that messages prints raw provider history which may contain secrets', () => {
    const result = runCli(['session', 'messages', '--help']);

    expect(result.status).toBe(0);
    const help = result.stdout.replace(/\s+/gu, ' ');
    expect(help).toContain('raw saved conductor provider history');
    expect(help).toContain('may contain secrets');
  });

  it('documents the worker messages options and raw transcript warning', () => {
    const result = runCli(['session', 'workers', 'messages', '--help']);

    expect(result.status).toBe(0);
    const help = result.stdout.replace(/\s+/gu, ' ');
    expect(help).toContain('--worker <name>');
    expect(help).toContain('--json');
    expect(help).toContain('currently Pi');
    expect(help).toContain('may contain secrets');
  });

  it('lists and filters local session fixtures without exposing stored secrets', () => {
    const result = runCli([
      'session',
      'list',
      '--repo-root',
      repoRoot,
      '--issue-url',
      ISSUE_URL,
      '--json',
    ]);

    expect(result.status).toBe(0);
    const output = JSON.parse(result.stdout);
    expect(output).toMatchObject({
      repoRoot,
      total: 1,
      sessions: [
        {
          conductorAgentId,
          issueUrl: ISSUE_URL,
          conductorBackend: 'pi',
          lifecycle: 'closed',
          harnessPhase: 'close',
          workers: ['implementer'],
        },
      ],
    });
    expect(result.stdout).not.toContain('SESSION_ENV_SECRET');
    expect(result.stdout).not.toContain('ACP_SESSION_SECRET');

    const unmatched = runCli([
      'session',
      'list',
      '--repo-root',
      repoRoot,
      '--issue-url',
      'https://github.com/otolab/agents-ensemble/issues/1',
      '--json',
    ]);
    expect(unmatched.status).toBe(0);
    expect(JSON.parse(unmatched.stdout).total).toBe(0);
  });

  it('shows YAML paths and counts without printing free-text values', () => {
    const result = runCli([
      'session',
      'show',
      conductorAgentId,
      '--repo-root',
      repoRoot,
      '--json',
    ]);

    expect(result.status).toBe(0);
    const output = JSON.parse(result.stdout);
    expect(output.session.conductorAgentId).toBe(conductorAgentId);
    expect(output.paths.sessionResumeStore).toContain(`${conductorAgentId}.json`);
    expect(output.relatedData.openQuestions).toMatchObject({
      found: true,
      summary: {
        sequence: 2,
        total: 2,
        open: 1,
        answered: 1,
      },
    });
    expect(output.relatedData.sessionState).toMatchObject({
      found: true,
      summary: {
        currentReportedAt: 1_800_000_000_020,
        historyCount: 1,
      },
    });
    expect(output.workerReaders).toMatchObject([
      {
        worker: 'implementer',
        preset: 'custom',
        status: 'unsupported',
        reason: expect.stringContaining('未対応'),
      },
    ]);
    for (const secret of [
      'SESSION_ENV_SECRET',
      'ACP_SESSION_SECRET',
      'QUESTION_SECRET',
      'ANSWER_SECRET',
      'STATUS_SECRET',
      'HISTORY_STATUS_SECRET',
    ]) {
      expect(result.stdout).not.toContain(secret);
    }

    const text = runCli([
      'session',
      'show',
      conductorAgentId,
      '--repo-root',
      repoRoot,
    ]);
    expect(text.status).toBe(0);
    expect(text.stdout).toContain('implementer (custom): 未対応');
  });

  it('reads provider history from the local Pi fixture and omits tool and thinking content', () => {
    const json = runCli([
      'session',
      'messages',
      conductorAgentId,
      '--repo-root',
      repoRoot,
      '--json',
    ]);

    expect(json.status).toBe(0);
    const result = JSON.parse(json.stdout);
    expect(result).toMatchObject({
      conductorAgentId,
      backend: 'pi',
      hasMore: false,
      messages: [
        {
          backend: 'pi',
          inbound: 'Local fixture inbound api_key=fixture-api-key-653',
          text: 'Local fixture response token=fixture-token-653',
          sendCount: 1,
          dispatchSource: 'operator',
        },
      ],
    });
    expect(json.stdout).toContain('fixture-api-key-653');
    expect(json.stdout).toContain('fixture-token-653');
    expect(json.stdout).not.toContain('TOOL_SECRET');
    expect(json.stdout).not.toContain('THINKING_SECRET');

    const text = runCli([
      'session',
      'messages',
      conductorAgentId,
      '--repo-root',
      repoRoot,
    ]);
    expect(text.status).toBe(0);
    expect(text.stdout).toContain('operator → conductor');
    expect(text.stdout).toContain(
      'Local fixture inbound api_key=fixture-api-key-653',
    );
    expect(text.stdout).toContain(
      'Local fixture response token=fixture-token-653',
    );
    expect(text.stdout).not.toContain('TOOL_SECRET');
    expect(text.stdout).not.toContain('THINKING_SECRET');
  });

  it('reads Pi ACP worker messages from the fixture in JSON and text', async () => {
    await writeResumeStore({
      preset: 'pi',
      acpCwd: WORKER_PI_CWD,
      acpSessionId: WORKER_PI_SESSION_ID,
    });
    await writePiAcpWorkerHistory();

    const json = runCli([
      'session',
      'workers',
      'messages',
      conductorAgentId,
      '--worker',
      'implementer',
      '--repo-root',
      repoRoot,
      '--json',
    ]);
    expect(json.status).toBe(0);
    const output = JSON.parse(json.stdout);
    expect(output).toMatchObject({
      conductorAgentId,
      worker: 'implementer',
      preset: 'pi',
      reader: 'pi-acp-jsonl',
      status: 'supported',
      messages: [
        {
          source: 'worker:implementer',
          providerId: 'root-user',
          role: 'user',
          text: 'Earlier worker request remains on the active branch.',
        },
        {
          source: 'worker:implementer',
          providerId: 'current-user',
          role: 'user',
          text: 'Pi ACP fixture user message.',
        },
        {
          source: 'worker:implementer',
          providerId: 'current-assistant',
          role: 'assistant',
          text: 'Pi ACP fixture assistant reply.',
        },
      ],
    });
    expect(json.stdout).not.toContain('Abandoned branch');
    expect(json.stdout).not.toContain('TOOL_SECRET');
    expect(json.stdout).not.toContain('THINKING_SECRET');

    const text = runCli([
      'session',
      'workers',
      'messages',
      conductorAgentId,
      '--worker',
      'implementer',
      '--repo-root',
      repoRoot,
    ]);
    expect(text.status).toBe(0);
    expect(text.stdout).toContain('(pi-acp-jsonl)');
    expect(text.stdout).toContain('user');
    expect(text.stdout).toContain('assistant');
    expect(text.stdout).toContain('Pi ACP fixture assistant reply.');
    expect(text.stdout).not.toContain('TOOL_SECRET');
    expect(text.stdout).not.toContain('THINKING_SECRET');

    const show = runCli([
      'session',
      'show',
      conductorAgentId,
      '--repo-root',
      repoRoot,
      '--json',
    ]);
    expect(JSON.parse(show.stdout).workerReaders).toMatchObject([
      {
        worker: 'implementer',
        preset: 'pi',
        status: 'supported',
        reader: 'pi-acp-jsonl',
      },
    ]);
  });

  it('returns unsupported JSON with exit code 2 for an unhandled preset', () => {
    const result = runCli([
      'session',
      'workers',
      'messages',
      conductorAgentId,
      '--worker',
      'implementer',
      '--repo-root',
      repoRoot,
      '--json',
    ]);

    expect(result.status).toBe(2);
    expect(JSON.parse(result.stdout)).toMatchObject({
      preset: 'custom',
      status: 'unsupported',
      reason: expect.stringContaining('custom'),
      messages: [],
    });
  });

  it('returns unavailable JSON with exit code 1 when Pi transcript data is missing', async () => {
    await writeResumeStore({
      preset: 'pi',
      acpCwd: WORKER_PI_CWD,
      acpSessionId: WORKER_PI_SESSION_ID,
    });

    const result = runCli([
      'session',
      'workers',
      'messages',
      conductorAgentId,
      '--worker',
      'implementer',
      '--repo-root',
      repoRoot,
      '--json',
    ]);

    expect(result.status).toBe(1);
    expect(JSON.parse(result.stdout)).toMatchObject({
      preset: 'pi',
      status: 'unavailable',
      reason: expect.stringContaining('session map が見つかりません'),
      messages: [],
    });
  });

  it('honors NO_COLOR even when FORCE_COLOR is set', () => {
    const result = runCli(
      ['session', 'list', '--repo-root', repoRoot],
      { FORCE_COLOR: '3', NO_COLOR: '1' },
    );

    expect(result.status).toBe(0);
    expect(result.stdout).not.toMatch(/\u001b\[/u);
  });

  async function writeResumeStore(
    options: {
      preset?: 'pi' | 'custom';
      acpCwd?: string;
      acpSessionId?: string;
    } = {},
  ): Promise<void> {
    const paths = resolveEnsemblePaths({ repoRoot, userEnsembleRoot: userRoot });
    const path = paths.sessionResumeStorePath(conductorAgentId);
    const preset = options.preset ?? 'custom';
    await mkdir(dirname(path), { recursive: true });
    await writeFile(
      path,
      `${JSON.stringify(
        {
          version: 1,
          conductorAgentId,
          conductorBackend: 'pi',
          conductorCwd,
          harnessSocketPath: join(tempRoot, 'missing-harness.sock'),
          issueUrl: ISSUE_URL,
          repoRoot,
          profile: {
            workers: [{ name: 'implementer', kind: 'implementer' }],
          },
          openQuestions: [],
          sequence: 0,
          workers: {
            implementer: {
              acpSessionId: options.acpSessionId ?? 'ACP_SESSION_SECRET',
              ...(options.acpCwd ? { acpCwd: options.acpCwd } : {}),
              acpSpawn: {
                preset,
                command: preset === 'pi' ? 'pi-acp' : 'fixture-acp',
                args: [],
                env: { API_TOKEN: 'SESSION_ENV_SECRET' },
              },
            },
          },
          lifecycle: 'closed',
          harnessPhase: 'close',
          updatedAt: 1_800_000_000_010,
        },
        null,
        2,
      )}\n`,
      'utf8',
    );
  }

  async function writePiAcpWorkerHistory(): Promise<void> {
    const transcriptPath = join(
      homeRoot,
      '.pi',
      'agent',
      'sessions',
      'pi-acp-worker-session.jsonl',
    );
    await mkdir(dirname(transcriptPath), { recursive: true });
    await copyFile(
      fileURLToPath(
        new URL(
          '../../core/test/fixtures/pi-acp-worker-session.jsonl',
          import.meta.url,
        ),
      ),
      transcriptPath,
    );

    const mapPath = join(homeRoot, '.pi', 'pi-acp', 'session-map.json');
    await mkdir(dirname(mapPath), { recursive: true });
    await writeFile(
      mapPath,
      `${JSON.stringify(
        {
          version: 1,
          sessions: {
            [WORKER_PI_SESSION_ID]: {
              sessionId: WORKER_PI_SESSION_ID,
              cwd: WORKER_PI_CWD,
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

  async function writeRelatedYaml(): Promise<void> {
    const paths = resolveEnsemblePaths({ repoRoot, userEnsembleRoot: userRoot });
    const questionsPath = paths.openQuestionsPath(conductorAgentId);
    const statePath = paths.sessionStatePath(conductorAgentId);
    await mkdir(dirname(questionsPath), { recursive: true });
    await writeFile(
      questionsPath,
      [
        'version: 1',
        'sequence: 2',
        'openQuestions:',
        '  - id: inq-1',
        '    question: QUESTION_SECRET',
        '    responseType: text',
        '    status: open',
        '    source: conductor',
        '    askedAt: 1800000000000',
        '  - id: inq-2',
        '    question: answered question',
        '    responseType: text',
        '    status: answered',
        '    source: conductor',
        '    askedAt: 1800000000001',
        '    answer: ANSWER_SECRET',
        '    answeredAt: 1800000000002',
        '',
      ].join('\n'),
      'utf8',
    );
    await writeFile(
      statePath,
      [
        'version: 2',
        'current:',
        '  statusLine: STATUS_SECRET',
        '  reportedAt: 1800000000020',
        'history:',
        '  - statusLine: HISTORY_STATUS_SECRET',
        '    reportedAt: 1800000000010',
        '',
      ].join('\n'),
      'utf8',
    );
  }

  async function writePiHistory(): Promise<void> {
    const piPackageEntry = new URL(
      '../../core/node_modules/@earendil-works/pi-coding-agent/dist/index.js',
      import.meta.url,
    );
    const { SessionManager } = await import(piPackageEntry.href);
    const sessionDir = join(conductorCwd, PI_SESSION_ROOT);
    const manager = SessionManager.create(conductorCwd, sessionDir, {
      id: conductorAgentId,
    });
    const inboundEntryId = manager.appendMessage({
      role: 'user',
      content: [
        {
          type: 'text',
          text: 'Local fixture inbound api_key=fixture-api-key-653',
        },
      ],
      timestamp: 1_800_000_000_000,
    });
    manager.appendMessage({
      role: 'assistant',
      content: [
        { type: 'thinking', thinking: 'THINKING_SECRET' },
        {
          type: 'toolCall',
          id: 'fixture-tool',
          name: 'shell',
          arguments: { command: 'TOOL_SECRET' },
        },
      ],
      api: 'anthropic-messages',
      provider: 'anthropic',
      model: 'fixture-model',
      usage: {},
      stopReason: 'toolUse',
      timestamp: 1_800_000_000_001,
    });
    manager.appendMessage({
      role: 'toolResult',
      toolCallId: 'fixture-tool',
      toolName: 'shell',
      content: [{ type: 'text', text: 'TOOL_SECRET' }],
      isError: false,
      timestamp: 1_800_000_000_002,
    });
    const responseEntryId = manager.appendMessage({
      role: 'assistant',
      content: [
        {
          type: 'text',
          text: 'Local fixture response token=fixture-token-653',
        },
      ],
      api: 'anthropic-messages',
      provider: 'anthropic',
      model: 'fixture-model',
      usage: {},
      stopReason: 'stop',
      timestamp: 1_800_000_000_003,
    });
    manager.appendCustomEntry(PI_HISTORY_ENTRY_TYPE, {
      inboundEntryId,
      responseEntryId,
      completedAt: 1_800_000_000_004,
      sendCount: 1,
      dispatchSource: 'operator',
    });
  }

  function runCli(
    args: string[],
    extraEnv: Record<string, string> = {},
  ) {
    const cliEntry = fileURLToPath(new URL('../dist/index.js', import.meta.url));
    return spawnSync(process.execPath, [cliEntry, ...args], {
      encoding: 'utf8',
      env: {
        ...process.env,
        ...extraEnv,
        HOME: homeRoot,
        ENSEMBLE_USER_ROOT: userRoot,
      },
      timeout: 10_000,
    });
  }
});
