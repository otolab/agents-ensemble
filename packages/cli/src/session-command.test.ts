import {
  copyFile,
  mkdir,
  mkdtemp,
  readFile,
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

const PI_HISTORY_ENTRY_TYPE = 'agents-ensemble/conductor-message-history/v1';
const ISSUE_URL = 'https://github.com/otolab/agents-ensemble/issues/653';
const ISSUE_NUMBER = 653;
const WORKER_PI_SESSION_ID = 'pi-acp-worker-fixture-session';
const WORKER_PI_CWD = '/tmp/pi-acp-worker-fixture';
const WORKER_CODEX_SESSION_ID = '019a4b21-9c0e-7a44-b9ad-6a8df4fa7720';
const WORKER_CODEX_CWD = '/tmp/codex-acp-worker-fixture';
const WORKER_CODEX_FILENAME_TIMESTAMP = '2026-11-09T14-03-00';
const CODEX_MODEL_PROVIDER_DIGEST_SECRET = 'a'.repeat(64);
const ACP_MODEL_CONFIG_DIGEST_SECRET = 'b'.repeat(64);

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
    expect(result.stdout).toContain('export');
    expect(result.stdout).toContain('without starting an agent');
  });

  it('documents raw session export options and its secret warning', () => {
    const result = runCli(['session', 'export', '--help']);

    expect(result.status).toBe(0);
    const help = result.stdout.replace(/\s+/gu, ' ');
    expect(help).toContain('--output <dir>');
    expect(help).toContain('--include-tool-calls');
    expect(help).toContain('--summary <path>');
    expect(help).toContain('--harness-log <path>');
    expect(help).toContain('may contain secrets');
  });

  it('exports a worktree Pi transcript and Codex worker history with one command', async () => {
    conductorAgentId = 'session-export-cli-worktree-fixture';
    conductorCwd = join(
      repoRoot,
      '.ensemble',
      'worktrees',
      'issue-672',
    );
    await mkdir(conductorCwd, { recursive: true });
    const entries = Array.from({ length: 101 }, (_, index) => ({
      sendCount: index + 1,
      dispatchSource: 'operator',
      completedAt: 1_800_000_000_000 + index,
      inbound: `turn-${String(index).padStart(3, '0')}-inbound`,
      response: `turn-${index}-response`,
    }));
    await writeResumeStore({
      preset: 'codex',
      acpCwd: WORKER_CODEX_CWD,
      acpSessionId: WORKER_CODEX_SESSION_ID,
    });
    await writeRelatedYaml();
    await writePiHistory(entries);
    await writeCodexAcpWorkerHistory();

    const outputDirectory = join(tempRoot, 'session-bundle');
    const result = runCli(
      [
        'session',
        'export',
        conductorAgentId,
        '--repo-root',
        repoRoot,
        '--output',
        outputDirectory,
        '--json',
      ],
      { CODEX_HOME: join(homeRoot, '.codex') },
    );

    expect(result.status).toBe(0);
    const exported = JSON.parse(result.stdout);
    expect(exported.status).toBe('complete');
    expect(exported.manifest.session).toMatchObject({
      conductorAgentId,
      repoRoot,
      conductorCwd,
      backend: 'pi',
      workers: [
        {
          name: 'implementer',
          preset: 'codex',
          acpCwd: WORKER_CODEX_CWD,
        },
      ],
    });
    const piTranscript = await readFile(
      join(outputDirectory, 'conductor/pi-transcript.jsonl'),
      'utf8',
    );
    expect(piTranscript).toContain('turn-000-inbound');
    expect(piTranscript).toContain('turn-100-inbound');

    const workerBundlePath =
      exported.manifest.session.workers[0].bundlePath;
    const workerHistory = JSON.parse(
      await readFile(join(outputDirectory, workerBundlePath), 'utf8'),
    );
    expect(workerHistory).toMatchObject({
      status: 'supported',
      worker: 'implementer',
      sourceFiles: expect.arrayContaining([
        expect.stringContaining('rollout-'),
      ]),
    });
    expect(workerHistory.messages.length).toBeGreaterThan(0);
  });

  it('documents the timeline inputs and raw diagnostic output', () => {
    const result = runCli(['session', 'timeline', '--help']);

    expect(result.status).toBe(0);
    const help = result.stdout.replace(/\s+/gu, ' ');
    expect(help).toContain('--summary <path>');
    expect(help).toContain('--harness-log <path>');
    expect(help).toContain('may contain secrets');
  });

  it('shows the Issue 650 reconnect gap without inventing a transcript pair', async () => {
    const fixturePath = fileURLToPath(
      new URL('../test/fixtures/session-650-reconnect-gap.json', import.meta.url),
    );
    const fixture = JSON.parse(await readFile(fixturePath, 'utf8')) as {
      summary: {
        agentId: string;
        issueUrl: string;
        repoRoot: string;
        startedAt: number;
        durationMs: number;
        sendCount: number;
        lastRunStatus: string;
        lastError: { message: string };
      };
      providerHistory: Array<{
        sendCount: number;
        dispatchSource: string;
        completedAt: number;
        inbound: string;
        response: string;
      }>;
      harnessLog: string[];
    };
    const backendStatus = 'error\u202e\u2066';
    fixture.summary.lastRunStatus = backendStatus;
    fixture.harnessLog = fixture.harnessLog.map((line) =>
      line.replace('status=error', `status=${backendStatus}`),
    );
    conductorAgentId = fixture.summary.agentId;
    await writeResumeStore({ issueUrl: fixture.summary.issueUrl });
    await writePiHistory(fixture.providerHistory);

    const summaryPath = join(tempRoot, 'session-summary.json');
    const harnessLogPath = join(tempRoot, 'harness.log');
    await writeFile(
      summaryPath,
      `${JSON.stringify(
        { ...fixture.summary, repoRoot },
        null,
        2,
      )}\n`,
      'utf8',
    );
    await writeFile(harnessLogPath, `${fixture.harnessLog.join('\n')}\n`, 'utf8');

    const result = runCli([
      'session',
      'timeline',
      conductorAgentId,
      '--repo-root',
      repoRoot,
      '--summary',
      summaryPath,
      '--harness-log',
      harnessLogPath,
      '--json',
    ]);

    expect(result.status).toBe(0);
    const output = JSON.parse(result.stdout);
    expect(output.sources).toMatchObject({
      providerHistory: {
        status: 'available',
        backend: 'pi',
        count: 2,
        hasMore: false,
      },
      sessionSummary: { status: 'available', path: summaryPath },
      harnessLog: {
        status: 'available',
        path: harnessLogPath,
        recognizedEventCount: 3,
      },
      sessionLogEvents: { status: 'not-persisted' },
      sendCorrelation: {
        status: 'available',
        basis:
          'Pi sendCount strictly inside a Date.now-derived SessionSummary window; boundaries excluded as ambiguous; assumes non-overlapping processes and a stable wall clock',
      },
    });
    expect(output.sendTimeline).toMatchObject([
      {
        sendCount: 98,
        providerPairStatus: 'available',
        providerMessages: [
          {
            dispatchSource: 'worker:implementer',
            inbound:
              'Continue the diagnosis after implementer completed.',
            text: 'Inspecting the saved provider history around the failed send.',
          },
        ],
      },
      {
        sendCount: 99,
        providerPairStatus: 'not-found',
        providerMessages: [],
        harnessEvents: [
          {
            kind: 'conductor.send',
            line: 2,
            status: 'error\\u202e\\u2066',
          },
          {
            kind: 'conductor.transport.reconnect',
            line: 3,
            status: 'attempt',
            previousSendCountInLog: 99,
          },
          {
            kind: 'conductor.transport.reconnect',
            line: 4,
            status: 'succeeded',
            previousSendCountInLog: 99,
          },
        ],
        summary: {
          sendCount: 99,
          lastRunStatus: 'error\\u202e\\u2066',
        },
      },
    ]);
    expect(output.gaps).toMatchObject([
      {
        missingFromSendCount: 99,
        missingThroughSendCount: 99,
        evidence: expect.arrayContaining([
          'harness log line 2: send #99 status=error\\u202e\\u2066',
          'harness log line 3: transport reconnect attempt',
          'SessionSummary: send #99 status=error\\u202e\\u2066',
        ]),
        explanation: expect.stringContaining(
          'raw transcript に未対応 entry があるか',
        ),
      },
    ]);
    expect(output.uncorrelatedProviderMessages).toMatchObject([
      {
        sendCount: 99,
        inbound: 'A send #99 from the previous harness process.',
        text: 'Previous process response; not part of this run.',
      },
    ]);

    const text = runCli([
      'session',
      'timeline',
      conductorAgentId,
      '--repo-root',
      repoRoot,
      '--summary',
      summaryPath,
      '--harness-log',
      harnessLogPath,
    ]);
    expect(text.status).toBe(0);
    expect(text.stdout).toContain('send #98');
    expect(text.stdout).toContain('send #99');
    expect(text.stdout).toContain(
      'conductor.send n=99 status=error\\u202e\\u2066',
    );
    expect(text.stdout).toContain('lastRunStatus=error\\u202e\\u2066');
    expect(text.stdout).not.toContain('\u202e');
    expect(text.stdout).not.toContain('\u2066');
    expect(text.stdout).toContain(
      'conductor.transport.reconnect status=succeeded',
    );
    expect(text.stdout).toContain(
      'provider history: send #99 に対応する inbound / response pair は見つかりません。',
    );
    expect(text.stdout).toContain(
      '今回の run と send 番号を照合していない provider history:',
    );
    expect(text.stdout).toContain('sendCount=99');
    expect(text.stdout).toContain('raw transcript に未対応 entry があるか');

    const withoutOptionalSources = runCli([
      'session',
      'timeline',
      conductorAgentId,
      '--repo-root',
      repoRoot,
      '--json',
    ]);
    const withoutSummary = JSON.parse(withoutOptionalSources.stdout);
    expect(withoutSummary.sources).toMatchObject({
      sessionSummary: { status: 'not-provided' },
      harnessLog: { status: 'not-provided' },
      sessionLogEvents: { status: 'not-persisted' },
      sendCorrelation: {
        status: 'unavailable',
        reason: expect.stringContaining('run ごとに再利用'),
      },
    });
    expect(withoutSummary.sendTimeline).toEqual([]);
    expect(withoutSummary.uncorrelatedProviderMessages).toHaveLength(2);

    const logWithoutSummary = runCli([
      'session',
      'timeline',
      conductorAgentId,
      '--repo-root',
      repoRoot,
      '--harness-log',
      harnessLogPath,
      '--json',
    ]);
    const unboundedLog = JSON.parse(logWithoutSummary.stdout);
    expect(unboundedLog.sendTimeline).toMatchObject([
      {
        sendCount: 99,
        providerPairStatus: 'not-correlatable',
        providerMessages: [],
        harnessEvents: [
          {
            kind: 'conductor.send',
            status: 'error\\u202e\\u2066',
          },
          { kind: 'conductor.transport.reconnect', status: 'attempt' },
          { kind: 'conductor.transport.reconnect', status: 'succeeded' },
        ],
      },
    ]);
    expect(unboundedLog.gaps).toEqual([]);
  });

  it('keeps Pi history on SessionSummary boundaries uncorrelated in JSON and text', async () => {
    conductorAgentId = 'session-fixture-655-boundaries';
    await writeResumeStore();
    const startedAt = 1_800_000_100_000;
    const durationMs = 1_000;
    const endedAt = startedAt + durationMs;
    const summaryPath = join(tempRoot, 'session-summary.json');
    await writePiHistory([
      {
        sendCount: 1,
        dispatchSource: 'worker:reviewer',
        completedAt: startedAt,
        inbound: 'Prior run entry at the resumed run start boundary.',
        response: 'Prior run response at the start boundary.',
      },
      {
        sendCount: 1,
        dispatchSource: 'operator',
        completedAt: startedAt + 1,
        inbound: 'Current run entry inside the summary window.',
        response: 'Current run response inside the summary window.',
      },
      {
        sendCount: 1,
        dispatchSource: 'worker:implementer',
        completedAt: endedAt,
        inbound: 'Following run entry at the previous run end boundary.',
        response: 'Following run response at the end boundary.',
      },
    ]);
    await writeFile(
      summaryPath,
      `${JSON.stringify({
        agentId: conductorAgentId,
        issueUrl: ISSUE_URL,
        repoRoot,
        startedAt,
        durationMs,
        sendCount: 1,
        lastRunStatus: 'finished',
      })}\n`,
      'utf8',
    );

    const json = runCli([
      'session',
      'timeline',
      conductorAgentId,
      '--repo-root',
      repoRoot,
      '--summary',
      summaryPath,
      '--json',
    ]);

    expect(json.status).toBe(0);
    const output = JSON.parse(json.stdout);
    expect(output.sources.sendCorrelation).toMatchObject({
      status: 'available',
      basis:
        'Pi sendCount strictly inside a Date.now-derived SessionSummary window; boundaries excluded as ambiguous; assumes non-overlapping processes and a stable wall clock',
    });
    expect(output.sendTimeline).toMatchObject([
      {
        sendCount: 1,
        providerPairStatus: 'available',
        providerMessages: [
          {
            inbound: 'Current run entry inside the summary window.',
            text: 'Current run response inside the summary window.',
          },
        ],
      },
    ]);
    expect(output.uncorrelatedProviderMessages).toMatchObject([
      {
        at: startedAt,
        sendCount: 1,
        inbound: 'Prior run entry at the resumed run start boundary.',
      },
      {
        at: endedAt,
        sendCount: 1,
        inbound: 'Following run entry at the previous run end boundary.',
      },
    ]);
    expect(output.gaps).toEqual([]);

    const text = runCli([
      'session',
      'timeline',
      conductorAgentId,
      '--repo-root',
      repoRoot,
      '--summary',
      summaryPath,
    ]);

    expect(text.status).toBe(0);
    expect(text.stdout).toContain(
      'send 番号の照合: Pi sendCount で照合（境界は除外。process の重複がなく、システム時計が安定している前提）',
    );
    const [timelineText, uncorrelatedText] = text.stdout.split(
      '今回の run と send 番号を照合していない provider history:',
    );
    expect(timelineText).toContain(
      'Current run entry inside the summary window.',
    );
    expect(timelineText).not.toContain('Prior run entry at the resumed run');
    expect(timelineText).not.toContain('Following run entry at the previous run');
    expect(uncorrelatedText).toContain(
      'Prior run entry at the resumed run start boundary.',
    );
    expect(uncorrelatedText).toContain(
      'Following run entry at the previous run end boundary.',
    );
  });

  it('reports missing provider, summary, and harness log sources explicitly', async () => {
    await rm(
      resolveEnsemblePaths({
        repoRoot,
        userEnsembleRoot: userRoot,
      }).piSessionsDir,
      { recursive: true, force: true },
    );
    const result = runCli([
      'session',
      'timeline',
      conductorAgentId,
      '--repo-root',
      repoRoot,
      '--summary',
      join(tempRoot, 'missing-summary.json'),
      '--harness-log',
      join(tempRoot, 'missing-harness.log'),
      '--json',
    ]);

    expect(result.status).toBe(0);
    const output = JSON.parse(result.stdout);
    expect(output.sources).toMatchObject({
      providerHistory: {
        status: 'unavailable',
        backend: 'pi',
        reason: expect.stringContaining('Provider history is unavailable'),
      },
      sessionSummary: {
        status: 'unavailable',
        reason: expect.stringContaining('ENOENT'),
      },
      harnessLog: {
        status: 'unavailable',
        reason: expect.stringContaining('ENOENT'),
      },
      sessionLogEvents: { status: 'not-persisted' },
      sendCorrelation: { status: 'unavailable' },
    });
    expect(output.sendTimeline).toEqual([]);
    expect(output.gaps).toEqual([]);
  });

  it('rejects a SessionSummary from another repository root', async () => {
    const summaryPath = join(tempRoot, 'session-summary.json');
    await writeFile(
      summaryPath,
      `${JSON.stringify({
        agentId: conductorAgentId,
        issueUrl: ISSUE_URL,
        repoRoot: join(tempRoot, 'other-repository'),
        startedAt: 1_800_000_000_000,
        durationMs: 100,
        sendCount: 1,
        lastRunStatus: 'finished',
      })}\n`,
      'utf8',
    );

    const result = runCli([
      'session',
      'timeline',
      conductorAgentId,
      '--repo-root',
      repoRoot,
      '--summary',
      summaryPath,
      '--json',
    ]);

    expect(result.status).toBe(0);
    const output = JSON.parse(result.stdout);
    expect(output.sources.sessionSummary).toMatchObject({
      status: 'unavailable',
      path: summaryPath,
      reason: expect.stringContaining('repoRoot'),
    });
    expect(output.sendTimeline).toEqual([]);
    expect(output.uncorrelatedProviderMessages).toMatchObject([
      { sendCount: 1 },
    ]);
  });

  it('marks malformed and invalid SessionSummary sources unavailable in JSON and text', async () => {
    const baseSummary = {
      agentId: conductorAgentId,
      issueUrl: ISSUE_URL,
      repoRoot,
      sendCount: 1,
      lastRunStatus: 'finished',
    };
    const invalidSummaries = [
      {
        name: 'malformed',
        content: '{"agentId":',
        reason: '有効な JSON ではありません。',
      },
      {
        name: 'negative-duration',
        content: JSON.stringify({
          ...baseSummary,
          startedAt: 1_800_000_000_000,
          durationMs: -1,
        }),
        reason:
          'SessionSummary の durationMs が負のため、開始後の時間窓として解釈できません。',
      },
      {
        name: 'unrepresentable-duration',
        content: JSON.stringify({
          ...baseSummary,
          startedAt: 0,
          durationMs: 1e100,
        }),
        reason:
          'SessionSummary の durationMs はミリ秒精度を保てる安全な整数ではありません。',
      },
      {
        name: 'fractional-started-at',
        content: JSON.stringify({
          ...baseSummary,
          startedAt: 1_800_000_000_000.5,
          durationMs: 100,
        }),
        reason:
          'SessionSummary の startedAt は Date.now() で表せる整数の Unix epoch ms ではありません。',
      },
      {
        name: 'unrepresentable-end',
        content: JSON.stringify({
          ...baseSummary,
          startedAt: 8_640_000_000_000_000,
          durationMs: 1,
        }),
        reason:
          'SessionSummary の時間窓終端 startedAt + durationMs は Date.now() で表せる整数の Unix epoch ms ではありません。',
      },
    ];

    for (const invalidSummary of invalidSummaries) {
      const summaryPath = join(
        tempRoot,
        `session-summary-${invalidSummary.name}.json`,
      );
      await writeFile(summaryPath, `${invalidSummary.content}\n`, 'utf8');

      const json = runCli([
        'session',
        'timeline',
        conductorAgentId,
        '--repo-root',
        repoRoot,
        '--summary',
        summaryPath,
        '--json',
      ]);

      expect(json.status).toBe(0);
      const output = JSON.parse(json.stdout);
      expect(output.sources.sessionSummary).toMatchObject({
        status: 'unavailable',
        path: summaryPath,
        reason: invalidSummary.reason,
      });
      expect(output.sources.sendCorrelation).toMatchObject({
        status: 'unavailable',
        reason:
          'Pi sendCount は run ごとに再利用されます。対象 run の有効な時間窓を示す SessionSummary がないため provider history と照合しません。',
      });
      expect(output.sessionSummary).toBeNull();
      expect(output.sendTimeline).toEqual([]);
      expect(output.uncorrelatedProviderMessages).toMatchObject([
        {
          sendCount: 1,
          inbound: 'Local fixture inbound api_key=fixture-api-key-653',
        },
      ]);

      const text = runCli([
        'session',
        'timeline',
        conductorAgentId,
        '--repo-root',
        repoRoot,
        '--summary',
        summaryPath,
      ]);

      expect(text.status).toBe(0);
      expect(text.stdout).toContain(
        `SessionSummary: 読取不能: ${invalidSummary.reason}`,
      );
      expect(text.stdout).toContain(
        'send 番号の照合: Pi sendCount は run ごとに再利用されます。対象 run の有効な時間窓を示す SessionSummary がないため provider history と照合しません。',
      );
      expect(text.stdout).toContain(
        '今回の run と send 番号を照合していない provider history:',
      );
      const [timelineText, uncorrelatedText] = text.stdout.split(
        '今回の run と send 番号を照合していない provider history:',
      );
      expect(timelineText).not.toContain(
        'Local fixture inbound api_key=fixture-api-key-653',
      );
      expect(uncorrelatedText).toContain(
        'Local fixture inbound api_key=fixture-api-key-653',
      );
    }
  }, 30_000);

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
    expect(help).toContain('currently Pi and Codex');
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

  it('shows and lists a session after migration from another clone', async () => {
    const migratedAgentId = 'session-migrated-from-another-clone';
    const migratedIssueUrl =
      'https://github.com/otolab/agents-ensemble/issues/698';
    const oldRepoRoot = join(tempRoot, 'old-clone');
    await mkdir(oldRepoRoot, { recursive: true });
    const init = spawnSync('git', ['init', '--quiet', repoRoot], {
      encoding: 'utf8',
    });
    expect(init.status).toBe(0);
    const remote = spawnSync(
      'git',
      [
        '-C',
        repoRoot,
        'remote',
        'add',
        'origin',
        'git@github.com:otolab/agents-ensemble.git',
      ],
      { encoding: 'utf8' },
    );
    expect(remote.status).toBe(0);

    const oldPaths = resolveEnsemblePaths({
      repoRoot: oldRepoRoot,
      userEnsembleRoot: userRoot,
    });
    const sourcePath = oldPaths.sessionResumeStorePath(migratedAgentId);
    await mkdir(dirname(sourcePath), { recursive: true });
    await writeFile(
      sourcePath,
      `${JSON.stringify({
        version: 1,
        conductorAgentId: migratedAgentId,
        issueUrl: migratedIssueUrl,
        repoRoot: oldRepoRoot,
        profile: { workers: [] },
        openQuestions: [],
        sequence: 0,
        workers: {},
        updatedAt: 1_800_000_000_698,
      }, null, 2)}\n`,
      'utf8',
    );

    const migrationScript = fileURLToPath(
      new URL(
        '../../../scripts/migrate-project-ensemble-runtime-to-user.mjs',
        import.meta.url,
      ),
    );
    const manifestPath = join(tempRoot, 'migration-manifest.json');
    const migration = spawnSync(
      process.execPath,
      [
        migrationScript,
        '--user-root',
        userRoot,
        '--manifest',
        manifestPath,
        '--apply',
      ],
      { encoding: 'utf8' },
    );
    expect(migration.status).toBe(0, migration.stderr);

    const slugStorePath = join(
      userRoot,
      'sessions',
      'github.com',
      'otolab',
      'agents-ensemble',
      `${migratedAgentId}.json`,
    );
    const migratedStore = JSON.parse(await readFile(slugStorePath, 'utf8'));
    expect(migratedStore.repoRoot).toBe(oldRepoRoot);
    expect(await readFile(sourcePath, 'utf8')).toContain(migratedAgentId);

    const show = runCli([
      'session',
      'show',
      migratedAgentId,
      '--repo-root',
      repoRoot,
      '--json',
    ]);
    expect(show.status).toBe(0);
    expect(JSON.parse(show.stdout)).toMatchObject({
      repoRoot,
      session: {
        conductorAgentId: migratedAgentId,
        issueUrl: migratedIssueUrl,
        location: 'canonical-slug',
      },
      paths: { sessionResumeStore: slugStorePath },
    });

    const list = runCli([
      'session',
      'list',
      '--repo-root',
      repoRoot,
      '--json',
    ]);
    expect(list.status).toBe(0);
    expect(JSON.parse(list.stdout).sessions).toContainEqual(
      expect.objectContaining({
        conductorAgentId: migratedAgentId,
        issueUrl: migratedIssueUrl,
        location: 'canonical-slug',
      }),
    );
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

  it.each(['running', 'exit'] as const)(
    'reads non-empty Pi provider history while the saved session is %s',
    async (harnessPhase) => {
      await writeResumeStore({ harnessPhase });
      const result = runCli([
        'session',
        'messages',
        conductorAgentId,
        '--repo-root',
        repoRoot,
        '--json',
      ]);

      expect(result.status).toBe(0);
      expect(JSON.parse(result.stdout).messages).toHaveLength(1);
    },
  );

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

  it('reads builtin Pi ACP worker messages from the user-scoped path', async () => {
    await writeResumeStore({
      preset: 'pi',
      acpCwd: WORKER_PI_CWD,
      acpSessionId: WORKER_PI_SESSION_ID,
      piRuntime: 'builtin',
    });
    await writePiAcpWorkerHistory({ runtime: 'builtin' });

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

    expect(result.status).toBe(0);
    expect(JSON.parse(result.stdout)).toMatchObject({
      worker: 'implementer',
      preset: 'pi',
      reader: 'pi-acp-jsonl',
      status: 'supported',
      messages: [
        {
          role: 'user',
          text: 'Earlier worker request remains on the active branch.',
        },
        { role: 'user', text: 'Pi ACP fixture user message.' },
        { role: 'assistant', text: 'Pi ACP fixture assistant reply.' },
      ],
    });
  });

  it('reads Codex ACP worker messages and reports support in session show', async () => {
    await writeResumeStore({
      preset: 'codex',
      acpCwd: WORKER_CODEX_CWD,
      acpSessionId: WORKER_CODEX_SESSION_ID,
    });
    await writeCodexAcpWorkerHistory();
    const codexHome = join(homeRoot, '.codex');

    const json = runCli(
      [
        'session',
        'workers',
        'messages',
        conductorAgentId,
        '--worker',
        'implementer',
        '--repo-root',
        repoRoot,
        '--json',
      ],
      { CODEX_HOME: codexHome },
    );
    expect(json.status).toBe(0);
    expect(JSON.parse(json.stdout)).toMatchObject({
      conductorAgentId,
      worker: 'implementer',
      preset: 'codex',
      reader: 'codex-cli-rollout-jsonl',
      status: 'supported',
      messages: [
        {
          source: 'worker:implementer',
          providerId: 'codex:2',
          role: 'user',
          text: 'Codex ACP fixture user message.',
        },
        {
          source: 'worker:implementer',
          providerId: 'codex:5',
          role: 'assistant',
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
      expect(json.stdout).not.toContain(hiddenContent);
    }

    const text = runCli(
      [
        'session',
        'workers',
        'messages',
        conductorAgentId,
        '--worker',
        'implementer',
        '--repo-root',
        repoRoot,
      ],
      { CODEX_HOME: codexHome },
    );
    expect(text.status).toBe(0);
    expect(text.stdout).toContain('(codex-cli-rollout-jsonl)');
    expect(text.stdout).toContain('Codex ACP fixture assistant reply.');

    const show = runCli([
      'session',
      'show',
      conductorAgentId,
      '--repo-root',
      repoRoot,
      '--json',
    ]);
    expect(show.status).toBe(0);
    expect(JSON.parse(show.stdout).workerReaders).toMatchObject([
      {
        worker: 'implementer',
        preset: 'codex',
        status: 'supported',
        reader: 'codex-cli-rollout-jsonl',
      },
    ]);
    expect(show.stdout).not.toContain(CODEX_MODEL_PROVIDER_DIGEST_SECRET);
    expect(show.stdout).not.toContain(ACP_MODEL_CONFIG_DIGEST_SECRET);
    expect(show.stdout).not.toContain('SESSION_ENV_SECRET');
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

  it('returns unavailable JSON when the Codex rollout is missing', async () => {
    await writeResumeStore({
      preset: 'codex',
      acpCwd: WORKER_CODEX_CWD,
      acpSessionId: WORKER_CODEX_SESSION_ID,
    });

    const result = runCli(
      [
        'session',
        'workers',
        'messages',
        conductorAgentId,
        '--worker',
        'implementer',
        '--repo-root',
        repoRoot,
        '--json',
      ],
      { CODEX_HOME: join(homeRoot, '.codex') },
    );

    expect(result.status).toBe(1);
    expect(JSON.parse(result.stdout)).toMatchObject({
      preset: 'codex',
      status: 'unavailable',
      reason: expect.stringContaining('rollout が見つかりません'),
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
      preset?: 'pi' | 'codex' | 'custom';
      acpCwd?: string;
      acpSessionId?: string;
      piRuntime?: 'builtin';
      issueUrl?: string;
      harnessPhase?: 'running' | 'exit';
      conductorBackend?: 'pi' | 'cursor';
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
          conductorBackend: options.conductorBackend ?? 'pi',
          conductorCwd,
          harnessSocketPath: join(tempRoot, 'missing-harness.sock'),
          issueUrl: options.issueUrl ?? ISSUE_URL,
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
                command:
                  preset === 'pi'
                    ? 'pi-acp'
                    : preset === 'codex'
                      ? 'codex-acp'
                      : 'fixture-acp',
                args: [],
                env: { API_TOKEN: 'SESSION_ENV_SECRET' },
                ...(preset === 'codex'
                  ? {
                      modelProviderDigest: CODEX_MODEL_PROVIDER_DIGEST_SECRET,
                    }
                  : {}),
                ...(options.piRuntime
                  ? { piRuntime: options.piRuntime }
                  : {}),
              },
            },
          },
          ...(preset === 'codex'
            ? {
                acpModelConfigDigest: ACP_MODEL_CONFIG_DIGEST_SECRET,
              }
            : {}),
          lifecycle: options.harnessPhase === 'exit' ? 'exited' : 'closed',
          harnessPhase: options.harnessPhase ?? 'close',
          updatedAt: 1_800_000_000_010,
        },
        null,
        2,
      )}\n`,
      'utf8',
    );
  }

  async function writePiAcpWorkerHistory(options?: {
    runtime?: 'builtin';
  }): Promise<void> {
    const paths = resolveEnsemblePaths({
      repoRoot,
      userEnsembleRoot: userRoot,
    });
    const transcriptPath =
      options?.runtime === 'builtin'
        ? join(
            paths.piWorkerSessionsDir('implementer', ISSUE_NUMBER),
            'pi-acp-worker-session.jsonl',
          )
        : join(
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

    const mapPath =
      options?.runtime === 'builtin'
        ? paths.piWorkerSessionMapPath('implementer', ISSUE_NUMBER)
        : join(homeRoot, '.pi', 'pi-acp', 'session-map.json');
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

  async function writeCodexAcpWorkerHistory(): Promise<void> {
    const codexHome = join(homeRoot, '.codex');
    const rolloutPath = join(
      codexHome,
      'sessions',
      '2026',
      '11',
      '09',
      `rollout-${WORKER_CODEX_FILENAME_TIMESTAMP}-${WORKER_CODEX_SESSION_ID}.jsonl`,
    );
    await mkdir(dirname(rolloutPath), { recursive: true });
    await copyFile(
      fileURLToPath(
        new URL(
          '../../core/test/fixtures/codex-cli-worker-rollout.jsonl',
          import.meta.url,
        ),
      ),
      rolloutPath,
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

  async function writePiHistory(
    entries?: Array<{
      sendCount: number;
      dispatchSource: string;
      completedAt: number;
      inbound: string;
      response: string;
    }>,
  ): Promise<void> {
    const piPackageEntry = new URL(
      '../../core/node_modules/@earendil-works/pi-coding-agent/dist/index.js',
      import.meta.url,
    );
    const { SessionManager } = await import(piPackageEntry.href);
    const sessionDir = resolveEnsemblePaths({
      repoRoot,
      userEnsembleRoot: userRoot,
    }).piSessionsDir;
    const manager = SessionManager.create(conductorCwd, sessionDir, {
      id: conductorAgentId,
    });
    if (entries) {
      for (const entry of entries) {
        const inboundEntryId = manager.appendMessage({
          role: 'user',
          content: [{ type: 'text', text: entry.inbound }],
          timestamp: entry.completedAt - 2,
        });
        const responseEntryId = manager.appendMessage({
          role: 'assistant',
          content: [{ type: 'text', text: entry.response }],
          api: 'anthropic-messages',
          provider: 'anthropic',
          model: 'fixture-model',
          usage: {},
          stopReason: 'stop',
          timestamp: entry.completedAt - 1,
        });
        manager.appendCustomEntry(PI_HISTORY_ENTRY_TYPE, {
          inboundEntryId,
          responseEntryId,
          completedAt: entry.completedAt,
          sendCount: entry.sendCount,
          dispatchSource: entry.dispatchSource,
        });
      }
      return;
    }

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
