import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { createServer, type Server } from 'node:net';
import { tmpdir } from 'node:os';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  resolveEnsemblePaths,
  startOpenQuestionControlServer,
  type GitHubClient,
} from '@agents-ensemble/core';
import { evaluateOperatorIdleCandidate } from './operator-idle-candidates.js';
import { DEFAULT_OPERATOR_AGENT_SCHEDULING } from './operator-agent-config.js';
import { createListOperatorSessionsTool } from './list-operator-sessions-tool.js';

describe('list_operator_sessions', () => {
  let repoRoot = '';

  beforeEach(async () => {
    repoRoot = await mkdtemp(join(tmpdir(), 'ensemble-operator-sessions-'));
    vi.stubEnv('HOME', repoRoot);
    vi.stubEnv('ENSEMBLE_USER_ROOT', join(repoRoot, '.user-ensemble'));
  });

  afterEach(async () => {
    await rm(repoRoot, { recursive: true, force: true });
    vi.unstubAllEnvs();
  });

  it('keeps stale-running confirmation distinct from live work status', async () => {
    const now = Date.now();
    const issue = 'https://github.com/example/project/issues/745';
    await writeResumeStore('active', 20, issue, { harnessPhase: 'running' });
    const tool = createListOperatorSessionsTool(repoRoot, () => ({
      connectivity: 'reachable', checkedAt: now, unreachableSince: null,
      snapshot: { sequence: 0, openQuestions: [], workStatus: 'working', sessionState: { current: { statusLine: 'last report', reportedAt: now - 3_600_000 }, history: [] } },
    }));
    const result = JSON.parse((await tool.execute({ includeGithub: false, workStatus: 'working' })).content[0]!.text);
    expect(result.sessions[0].workStatus.status).toBe('working');
    const candidate = evaluateOperatorIdleCandidate({ conductorAgentId: 'active', issueUrl: issue, observationVersion: 1, source: 'uds', connectivity: 'reachable', checkedAt: now, pollIntervalMs: 2000, harnessPhase: 'running', harnessModifiedAt: now - 1000, lifecycle: 'unknown', openQuestionCount: 0, statusLine: { text: 'last report', reportedAt: now - 3_600_000 } }, DEFAULT_OPERATOR_AGENT_SCHEDULING, now);
    expect(candidate?.kind).toBe('stale_running');
    expect(candidate?.text).toContain('停止・失敗・停滞とは断定せず');
  });

  it('uses the probe start time when a direct observation is delayed', async () => {
    const start = Date.now();
    let now = start;
    vi.spyOn(Date, 'now').mockImplementation(() => now);
    const server = await startOpenQuestionControlServer({
      listOpenQuestions: () => [],
      observeSession: async () => { now += 11_000; return { sequence: 0, openQuestions: [], workStatus: 'working' }; },
      answerOpenQuestion: async () => { throw new Error('unused'); },
    });
    try {
      await writeResumeStore('slow-observation', 10, 'https://github.com/example/project/issues/766', { harnessSocketPath: server.socketPath });
      const tool = createListOperatorSessionsTool(repoRoot);
      const result = JSON.parse((await tool.execute({ includeGithub: false, workStatus: 'unknown' })).content[0]!.text);
      expect(result.sessions).toMatchObject([{ workStatus: { status: 'unknown', source: 'uds', observedAt: start }, live: { freshness: 'stale' } }]);
    } finally { await server.close(); vi.restoreAllMocks(); }
  });

  it('filters fresh work observations and keeps old harnesses unknown', async () => {
    const issue = 'https://github.com/example/project/issues/1';
    for (const id of ['working', 'waiting', 'legacy', 'stale']) await writeResumeStore(id, 20, issue);
    const checkedAt = Date.now();
    const tool = createListOperatorSessionsTool(repoRoot, (id) => ({
      connectivity: 'reachable', checkedAt: id === 'stale' ? checkedAt - 20_000 : checkedAt, unreachableSince: null,
      snapshot: { sequence: 0, openQuestions: [], ...(id === 'working' || id === 'waiting' ? { workStatus: id } : id === 'stale' ? { workStatus: 'working' as const } : {}) },
    }));
    const working = JSON.parse((await tool.execute({ includeGithub: false, workStatus: 'working' })).content[0]!.text);
    expect(working.sessions).toMatchObject([{ conductorAgentId: 'working', workStatus: { status: 'working', source: 'uds', observedAt: checkedAt } }]);
    const waiting = JSON.parse((await tool.execute({ includeGithub: false, workStatus: 'waiting' })).content[0]!.text);
    expect(waiting.sessions).toMatchObject([{ conductorAgentId: 'waiting', workStatus: { status: 'waiting', source: 'uds' } }]);
    const unknown = JSON.parse((await tool.execute({ includeGithub: false, workStatus: 'unknown', limit: 1 })).content[0]!.text);
    expect(unknown.total).toBe(2);
    const next = JSON.parse((await tool.execute({ includeGithub: false, workStatus: 'unknown', limit: 1, cursor: unknown.nextCursor })).content[0]!.text);
    expect(next.sessions).toHaveLength(1);
    expect([...unknown.sessions, ...next.sessions]).toEqual(expect.arrayContaining([
      expect.objectContaining({ conductorAgentId: 'legacy', workStatus: { status: 'unknown', source: 'unavailable', observedAt: null } }),
      expect.objectContaining({ conductorAgentId: 'stale', workStatus: { status: 'unknown', source: 'uds', observedAt: checkedAt - 20_000 } }),
    ]));
    await expect(tool.execute({ includeGithub: false, workStatus: 'waiting', cursor: unknown.nextCursor })).rejects.toThrow('cursor');
  });

  it('returns recent SessionResumeStore summaries with open-question and worker details', async () => {
    const issueUrl = 'https://github.com/example/project/issues/1';
    await writeResumeStore('older', 10, issueUrl);
    await writeResumeStore('newer', 20, issueUrl, {
      lifecycle: 'closed',
      statusLine: '実装中：レビュー待ち',
    });
    const tool = createListOperatorSessionsTool(repoRoot);

    const result = await tool.execute({ limit: 1, sort: 'updatedAtDesc' });
    const summary = JSON.parse(result.content[0]!.text) as {
      total: number;
      returned: number;
      sessions: Array<{
        agentId: string;
        conductorAgentId: string;
        issueRef: { owner: string; repo: string; number: number };
        issueUrl: string;
        conductorBackend: string;
        statusLine: string | null;
        reportedAt: number | null;
        statusLineHistory: Array<{ statusLine: string; reportedAt: number }>;
        lifecycle: string;
        liveControlPathRecorded: boolean;
        openQuestionCount: number;
        openQuestionHistorySource: string;
        openQuestionHistoryStatus: string;
        openQuestionHistory: Array<{
          id: string;
          status: string;
          answer?: string;
        }>;
        workers: string[];
        openQuestions: Array<{ id: string; question: string }>;
        answeredQuestionCount: number;
      }>;
    };

    expect(summary).toMatchObject({
      total: 2,
      returned: 1,
      dataAsOf: expect.any(String),
      sessions: [
        {
          agentId: 'newer',
          conductorAgentId: 'newer',
          issueRef: { owner: 'example', repo: 'project', number: 1 },
          issueUrl,
          conductorBackend: 'cursor',
          statusLine: '実装中：レビュー待ち',
          reportedAt: expect.any(Number),
          statusLineHistory: [],
          lifecycle: 'closed',
          liveControlPathRecorded: false,
          openQuestionCount: 1,
          openQuestionHistorySource: 'resume_store_compatibility',
          openQuestionHistoryStatus: 'available',
          openQuestionHistory: [
            expect.objectContaining({ id: 'inq-open', status: 'open' }),
            expect.objectContaining({
              id: 'inq-answered',
              status: 'answered',
              answer: 'Yes.',
            }),
          ],
          workers: ['implementer'],
          openQuestions: [
            {
              id: 'inq-open',
              question: 'Should this proceed?',
            },
          ],
          answeredQuestionCount: 1,
        },
      ],
    });
    expect(summary.sessions[0]?.answeredQuestionCount).toBe(1);
    expect(result.structuredContent).toMatchObject({
      total: 2,
      returned: 1,
    });
  });

  it('searches live and saved values and paginates matching Issue groups', async () => {
    const firstIssue = 'https://github.com/example/project/issues/1';
    const secondIssue = 'https://github.com/example/project/issues/2';
    await writeResumeStore('a', 40, firstIssue, { statusLine: 'saved needle' });
    await writeResumeStore('b', 30, firstIssue, { statusLine: 'NEEDLE saved' });
    await writeResumeStore('c', 20, secondIssue, { statusLine: 'needle saved' });
    await writeResumeStore('d', 10, secondIssue, { statusLine: 'needle hidden' });
    const tool = createListOperatorSessionsTool(repoRoot, (id) => id === 'd' ? {
      connectivity: 'reachable', checkedAt: Date.now(), unreachableSince: null,
      snapshot: { sequence: 0, openQuestions: [{ id: 'live', question: 'Live question', responseType: 'yes_no', source: 'conductor', status: 'open', askedAt: 1 }], sessionState: { current: { statusLine: 'different', reportedAt: 10 }, history: [] } },
    } : undefined);
    const args = { keyword: 'Needle', groupByIssue: true, sort: 'updatedAtDesc', limit: 1, includeGithub: false };
    const first = JSON.parse((await tool.execute(args)).content[0]!.text);
    expect(first).toMatchObject({ total: 2, returned: 1, issues: [{ issueUrl: firstIssue, runs: [{ conductorAgentId: 'a', statusLineSource: 'conductor_report' }, { conductorAgentId: 'b' }] }] });
    const second = JSON.parse((await tool.execute({ ...args, cursor: first.nextCursor })).content[0]!.text);
    expect(second.issues).toMatchObject([{ issueUrl: secondIssue, runs: [{ conductorAgentId: 'c' }] }]);
    expect(second.nextCursor).toBeUndefined();
    await expect(tool.execute({ ...args, keyword: 'other', cursor: first.nextCursor })).rejects.toThrow('cursor');
    const questions = JSON.parse((await tool.execute({ keyword: 'proceed', includeGithub: false, limit: 1 })).content[0]!.text);
    expect(questions.sessions[0]).toMatchObject({ openQuestionCountSource: 'resume_store_compatibility' });
    expect(questions.nextCursor).toBeDefined();
    const live = JSON.parse((await tool.execute({ keyword: 'live question', includeGithub: false })).content[0]!.text);
    expect(live.sessions).toMatchObject([{ conductorAgentId: 'd', openQuestionCountSource: 'uds' }]);
  });

  it('accepts a cursor issued by the previous version for the ungrouped listing', async () => {
    const issue = 'https://github.com/example/project/issues/1';
    await writeResumeStore('first', 20, issue);
    await writeResumeStore('second', 10, issue);
    const scope = JSON.stringify({
      sort: 'updatedAtDesc', githubRepo: null, issueUrl: null,
      conductorAgentId: null, hasStatusLine: null, lifecycle: null,
      liveConnectivity: null, harnessPhase: null, hasOpenQuestions: null,
      minOpenQuestions: null, reportedBefore: null, profileIncludes: null, repoFilters: null,
    });
    const cursor = Buffer.from(JSON.stringify({ version: 2, sort: 'updatedAtDesc', scope,
      sortValue: 20, issueKey: 'example/project#1', conductorAgentId: 'first' })).toString('base64url');
    const tool = createListOperatorSessionsTool(repoRoot);
    const page = JSON.parse((await tool.execute({ sort: 'updatedAtDesc', limit: 1, cursor, includeGithub: false })).content[0]!.text);
    expect(page.sessions).toMatchObject([{ conductorAgentId: 'second' }]);
    expect(page.issues).toBeUndefined();
    await expect(tool.execute({ sort: 'updatedAtDesc', cursor, groupByIssue: true })).rejects.toThrow('cursor');
  });

  it('searches selected live and YAML values, excluding answered questions', async () => {
    const issue = 'https://github.com/example/project/issues/1';
    await writeResumeStore('saved', 20, issue, { statusLine: 'saved status' });
    await writeResumeStore('live', 10, issue, { statusLine: 'hidden saved status' });
    for (const id of ['saved', 'live']) {
      const path = resolveEnsemblePaths({ repoRoot }).canonicalOpenQuestionsPath(issue, id);
      await mkdir(dirname(path), { recursive: true });
      await writeFile(path, `version: 1
sequence: 2
openQuestions:
  - id: open
    question: YAML pending
    responseType: yes_no
    source: conductor
    status: open
    askedAt: 1
  - id: answered
    question: YAML resolved
    responseType: yes_no
    source: conductor
    status: answered
    askedAt: 1
    answer: Yes
`);
    }
    const tool = createListOperatorSessionsTool(repoRoot, (id) => id === 'live' ? {
      connectivity: 'reachable', checkedAt: Date.now(), unreachableSince: null,
      snapshot: { sequence: 2, openQuestions: [
        { id: 'open', question: 'Live pending', responseType: 'yes_no', source: 'conductor', status: 'open', askedAt: 1 },
        { id: 'answered', question: 'Live resolved', responseType: 'yes_no', source: 'conductor', status: 'answered', askedAt: 1, answer: 'Yes' },
      ], sessionState: { current: { statusLine: 'Live status', reportedAt: 15 }, history: [] } },
    } : undefined);
    const search = async (keyword: string) => JSON.parse((await tool.execute({ keyword, includeGithub: false })).content[0]!.text).sessions;
    expect(await search('live status')).toMatchObject([{ conductorAgentId: 'live', statusLineSource: 'uds' }]);
    expect(await search('yaml pending')).toMatchObject([{ conductorAgentId: 'saved', openQuestionCountSource: 'open_questions_yaml' }]);
    expect(await search('live pending')).toMatchObject([{ conductorAgentId: 'live', openQuestionCountSource: 'uds' }]);
    expect(await search('hidden saved status')).toEqual([]);
    expect(await search('resolved')).toEqual([]);
  });

  it('keeps each run state together across grouped page boundaries', async () => {
    const firstIssue = 'https://github.com/example/project/issues/1';
    const secondIssue = 'https://github.com/example/project/issues/2';
    await writeResumeStore('a', 40, firstIssue, { harnessPhase: 'running', statusLine: 'match saved' });
    await writeResumeStore('c', 30, secondIssue, { harnessPhase: 'close', statusLine: 'match second' });
    await writeResumeStore('b', 20, firstIssue, { harnessPhase: 'idle', statusLine: 'old saved' });
    const tool = createListOperatorSessionsTool(repoRoot, (id) => id === 'b' ? {
      connectivity: 'reachable', checkedAt: Date.now(), unreachableSince: null,
      snapshot: { sequence: 0, openQuestions: [], sessionState: { current: { statusLine: 'match live', reportedAt: 99 }, history: [] } },
    } : undefined);
    const args = { keyword: 'match', groupByIssue: true, sort: 'updatedAtDesc', limit: 1, includeGithub: false };
    const first = JSON.parse((await tool.execute(args)).content[0]!.text);
    expect(first.issues).toMatchObject([{ issueUrl: firstIssue, runs: [
      { conductorAgentId: 'a', live: { connectivity: 'unknown' }, persisted: { harnessPhase: 'running' }, statusLine: 'match saved', reportedAt: 41 },
      { conductorAgentId: 'b', live: { connectivity: 'reachable' }, persisted: { harnessPhase: 'idle' }, statusLine: 'match live', reportedAt: 99 },
    ] }]);
    const second = JSON.parse((await tool.execute({ ...args, cursor: first.nextCursor })).content[0]!.text);
    expect(second.issues).toMatchObject([{ issueUrl: secondIssue, runs: [{ conductorAgentId: 'c', persisted: { harnessPhase: 'close' } }] }]);
    expect(second.nextCursor).toBeUndefined();
    await expect(tool.execute({ ...args, groupByIssue: false, cursor: first.nextCursor })).rejects.toThrow('cursor');
    const plain = JSON.parse((await tool.execute({ ...args, groupByIssue: false, limit: 2 })).content[0]!.text);
    expect(plain.sessions.map((run: { conductorAgentId: string }) => run.conductorAgentId)).toEqual(['a', 'c']);
    const plainNext = JSON.parse((await tool.execute({ ...args, groupByIssue: false, limit: 2, cursor: plain.nextCursor })).content[0]!.text);
    expect(plainNext.sessions.map((run: { conductorAgentId: string }) => run.conductorAgentId)).toEqual(['b']);
  });

  it('filters by statusLine and lifecycle; older Issue records without lifecycle are unknown', async () => {
    const issueUrl = 'https://github.com/example/project/issues/1';
    await writeResumeStore('legacy', 10, issueUrl);
    await writeResumeStore('closed', 20, issueUrl, {
      lifecycle: 'closed',
      statusLine: 'CI 確認中',
    });
    await writeResumeStore('exited', 30, issueUrl, { lifecycle: 'exited' });
    const tool = createListOperatorSessionsTool(repoRoot);

    const reported = JSON.parse(
      (await tool.execute({ hasStatusLine: true })).content[0]!.text,
    ) as { sessions: Array<{ conductorAgentId: string }> };
    expect(reported.sessions.map((session) => session.conductorAgentId)).toEqual([
      'closed',
    ]);

    const legacy = JSON.parse(
      (
        await tool.execute({
          hasStatusLine: false,
          lifecycle: 'unknown',
        })
      ).content[0]!.text,
    ) as { sessions: Array<{ conductorAgentId: string; lifecycle: string }> };
    expect(legacy.sessions).toEqual([
      expect.objectContaining({
        conductorAgentId: 'legacy',
        lifecycle: 'unknown',
      }),
    ]);

    const sameIssueInstances = JSON.parse(
      (await tool.execute({ sort: 'updatedAtAsc' })).content[0]!.text,
    ) as { sessions: Array<{ conductorAgentId: string; issueUrl: string }> };
    expect(sameIssueInstances.sessions).toEqual([
      expect.objectContaining({ conductorAgentId: 'legacy', issueUrl }),
      expect.objectContaining({ conductorAgentId: 'closed', issueUrl }),
      expect.objectContaining({ conductorAgentId: 'exited', issueUrl }),
    ]);
  });

  it('filters multiple runs of one Issue by exact Issue URL and conductorAgentId', async () => {
    const issueUrl = 'https://github.com/example/project/issues/691';
    const otherIssueUrl = 'https://github.com/example/project/issues/694';
    await writeResumeStore('run-a', 10, issueUrl);
    await writeResumeStore('run-b', 20, issueUrl);
    await writeResumeStore('other-issue', 30, otherIssueUrl);
    const tool = createListOperatorSessionsTool(repoRoot);

    const issueRuns = JSON.parse(
      (await tool.execute({ issueUrl, sort: 'updatedAtDesc' })).content[0]!
        .text,
    ) as {
      total: number;
      sessions: Array<{ issueUrl: string; conductorAgentId: string }>;
    };
    expect(issueRuns).toMatchObject({
      total: 2,
      sessions: [
        { issueUrl, conductorAgentId: 'run-b' },
        { issueUrl, conductorAgentId: 'run-a' },
      ],
    });

    const selectedRun = JSON.parse(
      (
        await tool.execute({
          issueUrl,
          conductorAgentId: 'run-a',
        })
      ).content[0]!.text,
    ) as {
      total: number;
      sessions: Array<{ issueUrl: string; conductorAgentId: string }>;
    };
    expect(selectedRun).toMatchObject({
      total: 1,
      sessions: [{ issueUrl, conductorAgentId: 'run-a' }],
    });

    const firstPage = JSON.parse(
      (await tool.execute({ issueUrl, limit: 1, sort: 'updatedAtDesc' }))
        .content[0]!.text,
    ) as { nextCursor: string };
    await expect(
      tool.execute({ issueUrl: otherIssueUrl, cursor: firstPage.nextCursor }),
    ).rejects.toThrow('Invalid operator session cursor or it does not match');
  });

  it('applies profile and CLI repository scopes with cursor pagination', async () => {
    const firstUrl = 'https://github.com/org/one/issues/1';
    const secondUrl = 'https://github.com/org/one/issues/2';
    await writeResumeStore('one-first', 30, firstUrl);
    await writeResumeStore('one-second', 20, secondUrl);
    await writeResumeStore(
      'profile-excluded',
      40,
      'https://github.com/org/two/issues/3',
    );
    await writeResumeStore(
      'filter-excluded',
      50,
      'https://github.com/other/repo/issues/4',
    );
    const tool = createListOperatorSessionsTool({
      userEnsembleRoot: join(repoRoot, '.user-ensemble'),
      profileIncludes: ['org/*'],
      repoFilters: ['org/one', 'other/*'],
    });

    const first = JSON.parse(
      (await tool.execute({ limit: 1, sort: 'updatedAtDesc' })).content[0]!
        .text,
    ) as {
      total: number;
      returned: number;
      nextCursor?: string;
      sessions: Array<{ conductorAgentId: string }>;
      repoRoot?: string;
    };
    expect(first).toMatchObject({
      total: 2,
      returned: 1,
      sessions: [{ conductorAgentId: 'one-first' }],
    });
    expect(first.nextCursor).toBeDefined();
    expect(first).not.toHaveProperty('repoRoot');

    const second = JSON.parse(
      (
        await tool.execute({
          limit: 1,
          cursor: first.nextCursor,
          sort: 'updatedAtDesc',
        })
      ).content[0]!.text,
    ) as {
      total: number;
      returned: number;
      nextCursor?: string;
      sessions: Array<{ conductorAgentId: string }>;
    };
    expect(second).toMatchObject({
      total: 2,
      returned: 1,
      sessions: [{ conductorAgentId: 'one-second' }],
    });
    expect(second.nextCursor).toBeUndefined();
  });

  it('returns bounded statusLine history through the existing list tool', async () => {
    const issueUrl = 'https://github.com/example/project/issues/499';
    await writeResumeStore('history', 30, issueUrl, {
      statusLine: '最新の報告',
    });
    await writeFile(
      resolveEnsemblePaths({ repoRoot }).canonicalSessionStatePath(issueUrl, 'history'),
      [
        'version: 2',
        'current:',
        '  statusLine: 最新の報告',
        '  reportedAt: 30',
        'history:',
        '  - statusLine: 最初の報告',
        '    reportedAt: 10',
        '  - statusLine: 前の報告',
        '    reportedAt: 20',
        '',
      ].join('\n'),
      'utf8',
    );

    const result = JSON.parse(
      (await createListOperatorSessionsTool(repoRoot).execute({})).content[0]!
        .text,
    ) as {
      sessions: Array<{
        statusLine: string | null;
        reportedAt: number | null;
        statusLineHistory: Array<{ statusLine: string; reportedAt: number }>;
      }>;
    };
    expect(result.sessions[0]).toEqual(
      expect.objectContaining({
        statusLine: '最新の報告',
        reportedAt: 30,
        statusLineHistory: [
          { statusLine: '最初の報告', reportedAt: 10 },
          { statusLine: '前の報告', reportedAt: 20 },
        ],
      }),
    );
  });

  it('sorts newness by first observation and labels stale live and count comparisons', async () => {
    const issueUrl = 'https://github.com/example/project/issues/743';
    await writeResumeStore('run-old', 900, issueUrl, {
      lifecycle: 'closed',
      statusLine: '保存済みの最新報告',
    });
    await writeResumeStore('run-new', 100, issueUrl);
    const observations: Record<string, number> = {
      'run-old': 1_000,
      'run-new': 2_000,
    };
    const checkedAt = Date.now() - 20_000;
    const tool = createListOperatorSessionsTool(
      { userEnsembleRoot: join(repoRoot, '.user-ensemble') },
      (conductorAgentId) => ({
        connectivity: 'unreachable',
        checkedAt,
        unreachableSince: checkedAt,
      }),
      undefined,
      (conductorAgentId) => ({
        firstObservedAt: observations[conductorAgentId] ?? null,
        repositoryWatchEnabled: true,
        repositoryScan: {
          status: 'fresh',
          checkedAt,
          error: null,
        },
        watchEnabled: conductorAgentId === 'run-new',
        watchSource:
          conductorAgentId === 'run-new' ? 'repository_auto' : null,
        watchReason:
          conductorAgentId === 'run-new' ? 'watching' : 'auto_watch_capacity',
        pollIntervalMs: conductorAgentId === 'run-new' ? 10_000 : null,
        questionCountObservation: {
          metric: 'unanswered_open_questions',
          current: { count: 3, checkedAt: checkedAt + 1_000, source: 'uds' },
          previous: {
            count: 1,
            checkedAt,
            source: 'resume_store',
          },
        },
      }),
    );
    const first = JSON.parse(
      (await tool.execute({ limit: 1, includeGithub: false })).content[0]!
        .text,
    ) as {
      nextCursor: string;
      sessions: Array<Record<string, any>>;
    };
    expect(first.sessions[0]).toMatchObject({
      conductorAgentId: 'run-new',
      updatedAtMeaning: 'resume_store_flush_time',
      discovery: {
        firstObservedAt: 2_000,
        timeSource: 'repository_watch_first_observed',
      },
      live: {
        connectivity: 'unknown',
        lastKnownConnectivity: 'unreachable',
        freshness: 'stale',
        checkedAt,
      },
      watch: {
        enabled: true,
        source: 'repository_auto',
        reason: 'watching',
      },
      openQuestionObservation: {
        metric: 'unanswered_open_questions',
        status: 'observed',
        current: { count: 3, source: 'uds' },
        previous: { count: 1, source: 'resume_store' },
        delta: 2,
        comparedAt: checkedAt,
      },
      pullRequests: { status: 'not_requested' },
    });
    const second = JSON.parse(
      (
        await tool.execute({
          limit: 1,
          cursor: first.nextCursor,
          includeGithub: false,
        })
      ).content[0]!.text,
    ) as { sessions: Array<Record<string, any>> };
    expect(second.sessions[0]).toMatchObject({
      conductorAgentId: 'run-old',
      statusLine: '保存済みの最新報告',
      statusLineSource: 'conductor_report',
      watch: { enabled: false, reason: 'auto_watch_capacity' },
    });
  });

  it('limits GitHub lookups per page and reports details, failure, and stale cache', async () => {
    const issueUrls = Array.from(
      { length: 6 },
      (_, index) => `https://github.com/example/project/issues/${800 + index}`,
    );
    await Promise.all(
      issueUrls.map((issueUrl, index) =>
        writeResumeStore(`github-run-${index}`, index, issueUrl),
      ),
    );
    const response = {
      status: 'available' as const,
      pullRequests: [
        {
          number: 900,
          title: 'Fix run discovery',
          url: 'https://github.com/example/project/pull/900',
          state: 'OPEN',
          headRefName: 'feature/run-discovery',
          headRefOid: 'sha-900',
          reviewDecision: 'APPROVED' as const,
          checks: [
            {
              type: 'check_run' as const,
              name: 'test',
              status: 'COMPLETED',
              conclusion: 'SUCCESS',
              url: 'https://github.com/example/project/actions/runs/1',
              headSha: 'sha-900',
            },
          ],
          checksTruncated: false,
        },
      ],
      pullRequestsTruncated: false,
    };
    const getIssuePullRequestSummaries = vi.fn().mockResolvedValue(response);
    const client = {
      getIssuePullRequestSummaries,
    } as unknown as GitHubClient;
    const tool = createListOperatorSessionsTool({
      userEnsembleRoot: join(repoRoot, '.user-ensemble'),
      getGitHubClient: async () => client,
    });
    const first = JSON.parse(
      (await tool.execute({ limit: 10, sort: 'updatedAtAsc' })).content[0]!
        .text,
    ) as { sessions: Array<Record<string, any>> };
    expect(getIssuePullRequestSummaries).toHaveBeenCalledTimes(5);
    expect(
      first.sessions.filter(
        (session) => session.pullRequests.status === 'not_checked',
      ),
    ).toHaveLength(1);
    expect(first.sessions[0]?.pullRequests).toMatchObject({
      status: 'available',
      source: 'github_api',
      items: [
        {
          number: 900,
          head: { ref: 'feature/run-discovery', sha: 'sha-900' },
          review: {
            decision: 'APPROVED',
            source: 'github_api',
          },
          checks: {
            status: 'available',
            items: [{ name: 'test', conclusion: 'SUCCESS' }],
          },
        },
      ],
    });

    const second = JSON.parse(
      (await tool.execute({ limit: 1, sort: 'updatedAtAsc' })).content[0]!
        .text,
    ) as { sessions: Array<Record<string, any>> };
    expect(second.sessions[0]?.pullRequests.status).toBe('available');
    vi.useFakeTimers();
    try {
      vi.setSystemTime(Date.now() + 31_000);
      getIssuePullRequestSummaries.mockRejectedValueOnce(
        new Error('temporary network failure'),
      );
      const stale = JSON.parse(
        (await tool.execute({ limit: 1, sort: 'updatedAtAsc' })).content[0]!
          .text,
      ) as { sessions: Array<Record<string, any>> };
      // The page cache expires after 30 seconds. A failed refresh retains only
      // the previous successful result and marks it stale.
      expect(stale.sessions[0]?.pullRequests).toMatchObject({
        status: 'stale',
        refreshFailure: 'request_failed',
        items: [{ number: 900 }],
      });
    } finally {
      vi.useRealTimers();
    }
  });

  it('distinguishes a verified Issue with no PR references from unavailable GraphQL data', async () => {
    const withoutReference =
      'https://github.com/example/project/issues/810';
    const unavailableIssue =
      'https://github.com/example/project/issues/811';
    await writeResumeStore('no-pr-run', 20, withoutReference);
    await writeResumeStore('unavailable-pr-run', 10, unavailableIssue);
    const client = {
      getIssuePullRequestSummaries: vi.fn(async (
        _owner: string,
        _repo: string,
        issueNumber: number,
      ) =>
        issueNumber === 810
          ? {
              status: 'available' as const,
              pullRequests: [],
              pullRequestsTruncated: false,
            }
          : {
              status: 'unavailable' as const,
              reason: 'issue_unavailable' as const,
            },
      ),
    } as unknown as GitHubClient;
    const tool = createListOperatorSessionsTool({
      userEnsembleRoot: join(repoRoot, '.user-ensemble'),
      getGitHubClient: async () => client,
    });

    const result = JSON.parse(
      (await tool.execute({ sort: 'updatedAtAsc' })).content[0]!.text,
    ) as {
      sessions: Array<{
        conductorAgentId: string;
        pullRequests: Record<string, unknown>;
      }>;
    };

    expect(result.sessions).toEqual([
      expect.objectContaining({
        conductorAgentId: 'unavailable-pr-run',
        pullRequests: {
          status: 'unavailable',
          source: null,
          checkedAt: null,
          freshness: 'not_observed',
          reason: 'issue_unavailable',
          items: [],
        },
      }),
      expect.objectContaining({
        conductorAgentId: 'no-pr-run',
        pullRequests: expect.objectContaining({
          status: 'none',
          source: 'github_api',
          freshness: 'fresh',
          items: [],
        }),
      }),
    ]);
  });

  it('ignores path-hash status YAML for listed Issue sessions', async () => {
    const paths = resolveEnsemblePaths({ repoRoot });
    const hashIssueUrl = 'https://github.com/example/hash-list/issues/607';
    const slugIssueUrl = 'https://github.com/example/slug-list/issues/607';
    await writeResumeStore('hash-selected', 10, hashIssueUrl, {
    });
    const hashSlugYaml = paths.canonicalSessionStatePath(
      hashIssueUrl,
      'hash-selected',
    );
    await mkdir(dirname(hashSlugYaml), { recursive: true });
    await writeFile(
      hashSlugYaml,
      'version: 1\nstatusLine: "canonical slug snapshot"\nreportedAt: 11\n',
      'utf8',
    );

    await writeResumeStore('slug-selected', 20, slugIssueUrl);
    const hashStatePath = paths.legacyHashSessionStatePath('slug-selected');
    await mkdir(dirname(hashStatePath), { recursive: true });
    await writeFile(
      hashStatePath,
      'version: 1\nstatusLine: "hash fallback snapshot"\nreportedAt: 21\n',
      'utf8',
    );

    const result = JSON.parse(
      (await createListOperatorSessionsTool(repoRoot).execute({})).content[0]!
        .text,
    ) as {
      sessions: Array<{ conductorAgentId: string; statusLine: string | null }>;
    };
    expect(result.sessions).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          conductorAgentId: 'hash-selected',
          statusLine: 'canonical slug snapshot',
        }),
        expect.objectContaining({
          conductorAgentId: 'slug-selected',
          statusLine: null,
        }),
      ]),
    );
  });

  it('uses Open Questions YAML as the stopped-session history source', async () => {
    const issueUrl = 'https://github.com/example/project/issues/692';
    await writeResumeStore('yaml-history', 30, issueUrl);
    const paths = resolveEnsemblePaths({
      repoRoot,
      userEnsembleRoot: join(repoRoot, '.user-ensemble'),
    });
    const path = paths.canonicalOpenQuestionsPath(issueUrl, 'yaml-history');
    await mkdir(dirname(path), { recursive: true });
    await writeFile(
      path,
      [
        'version: 1',
        'sequence: 2',
        'openQuestions:',
        '  - id: inq-1',
        '    question: Should the release proceed?',
        '    responseType: yes_no',
        '    source: conductor',
        '    status: answered',
        '    askedAt: 10',
        '    answer: Yes, after CI passed.',
        '    assent: yes',
        '    approved: true',
        '    answeredAt: 20',
        '    answeredBy: operator',
        '  - id: inq-2',
        '    question: Which rollout?',
        '    responseType: choice',
        '    source: conductor',
        '    status: open',
        '    askedAt: 30',
        '    choices:',
        '      - id: canary',
        '        label: Canary',
        '',
      ].join('\n'),
      'utf8',
    );

    const result = JSON.parse(
      (
        await createListOperatorSessionsTool({
          userEnsembleRoot: join(repoRoot, '.user-ensemble'),
        }).execute({ issueUrl })
      ).content[0]!.text,
    ) as {
      sessions: Array<{
        openQuestionCount: number | null;
        answeredQuestionCount: number | null;
        openQuestionHistorySource: string;
        openQuestions: Array<{ id: string; question: string }>;
        openQuestionHistory: Array<{
          id: string;
          answer?: string;
          answeredBy?: string;
        }>;
      }>;
    };
    expect(result.sessions[0]).toMatchObject({
      openQuestionCount: 1,
      answeredQuestionCount: 1,
      openQuestionHistorySource: 'open_questions_yaml',
      openQuestions: [
        { id: 'inq-2', question: 'Which rollout?' },
      ],
      openQuestionHistory: [
        {
          id: 'inq-1',
          answer: 'Yes, after CI passed.',
          answeredBy: 'operator',
        },
        { id: 'inq-2' },
      ],
    });
  });

  it('does not fall back to the compatibility copy when Open Questions YAML is unreadable', async () => {
    const issueUrl = 'https://github.com/example/project/issues/693';
    await writeResumeStore('bad-yaml', 30, issueUrl);
    const paths = resolveEnsemblePaths({
      repoRoot,
      userEnsembleRoot: join(repoRoot, '.user-ensemble'),
    });
    const path = paths.canonicalOpenQuestionsPath(issueUrl, 'bad-yaml');
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, 'version: [broken', 'utf8');

    const result = JSON.parse(
      (
        await createListOperatorSessionsTool({
          userEnsembleRoot: join(repoRoot, '.user-ensemble'),
        }).execute({ issueUrl })
      ).content[0]!.text,
    ) as {
      sessions: Array<{
        openQuestionCount: number | null;
        answeredQuestionCount: number | null;
        openQuestionHistoryStatus: string;
        openQuestionHistorySource: string;
        openQuestionHistory: unknown[];
      }>;
    };
    expect(result.sessions[0]).toMatchObject({
      openQuestionCount: null,
      answeredQuestionCount: null,
      openQuestionHistoryStatus: 'unavailable',
      openQuestionHistorySource: 'unavailable',
      openQuestionHistory: [],
    });
  });

  it('projects persisted phase against live observation time', async () => {
    const issueUrl = 'https://github.com/example/project/issues/561';
    const now = Date.now();
    await writeResumeStore('running', now, issueUrl, {
      harnessPhase: 'running',
      modifiedAt: now,
    });
    await writeResumeStore('closed', now - 1, issueUrl, {
      lifecycle: 'closed',
    });
    await writeResumeStore('exited-live', now, issueUrl, {
      harnessPhase: 'exit',
      modifiedAt: now,
    });
    await writeResumeStore('closed-stale-live', now, issueUrl, {
      harnessPhase: 'close',
      modifiedAt: now,
    });
    const tool = createListOperatorSessionsTool(repoRoot, (id) => {
      if (id === 'running') {
        return {
          connectivity: 'reachable',
          checkedAt: now,
          unreachableSince: null,
        };
      }
      if (id === 'exited-live') {
        return {
          connectivity: 'reachable',
          checkedAt: now,
          unreachableSince: null,
        };
      }
      if (id === 'closed-stale-live') {
        return {
          connectivity: 'reachable',
          checkedAt: now - 1,
          unreachableSince: null,
        };
      }
      return undefined;
    });

    const result = JSON.parse((await tool.execute({})).content[0]!.text) as {
      sessions: Array<{
        conductorAgentId: string;
        persisted: {
          harnessPhase: string | null;
          modifiedAt: number | null;
          source: string;
        };
        live: { connectivity: string; checkedAt: number | null };
        posture: string;
        coherence: string;
        coherenceReasons?: string[];
      }>;
    };
    expect(result.sessions).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          conductorAgentId: 'running',
          persisted: {
            harnessPhase: 'running',
            modifiedAt: now,
            source: 'resume_store',
          },
          live: expect.objectContaining({
            connectivity: 'reachable',
            checkedAt: now,
          }),
          posture: 'interact',
          coherence: 'ok',
        }),
        expect.objectContaining({
          conductorAgentId: 'closed',
          persisted: {
            harnessPhase: 'close',
            modifiedAt: null,
            source: 'legacy_lifecycle',
          },
          live: expect.objectContaining({
            connectivity: 'unknown',
            checkedAt: null,
          }),
          posture: 'resume',
          coherence: 'insufficient_data',
        }),
        expect.objectContaining({
          conductorAgentId: 'exited-live',
          posture: 'indeterminate',
          coherence: 'conflict',
        }),
        expect.objectContaining({
          conductorAgentId: 'closed-stale-live',
          persisted: {
            harnessPhase: 'close',
            modifiedAt: now,
            source: 'resume_store',
          },
          live: expect.objectContaining({
            connectivity: 'reachable',
            checkedAt: now - 1,
          }),
          posture: 'resume',
          coherence: 'insufficient_data',
          coherenceReasons: ['live_observation_predates_phase'],
        }),
      ]),
    );
  });

  it('waits through the unreachable grace window before reporting a conflict', async () => {
    const issueUrl = 'https://github.com/example/project/issues/562';
    const now = Date.now();
    await writeResumeStore('stale-running', now, issueUrl, {
      harnessPhase: 'running',
      modifiedAt: now,
    });
    const tool = createListOperatorSessionsTool(repoRoot, () => ({
      connectivity: 'unreachable',
      checkedAt: now,
      unreachableSince: now - 29_000,
    }));
    const duringGrace = JSON.parse(
      (await tool.execute({})).content[0]!.text,
    ) as { sessions: Array<{ coherence: string }> };
    expect(duringGrace.sessions[0]?.coherence).toBe('insufficient_data');

    const afterGrace = createListOperatorSessionsTool(repoRoot, () => ({
      connectivity: 'unreachable',
      checkedAt: now,
      unreachableSince: now - 31_000,
    }));
    const conflicted = JSON.parse(
      (await afterGrace.execute({})).content[0]!.text,
    ) as {
      sessions: Array<{ posture: string; coherence: string }>;
    };
    expect(conflicted.sessions[0]).toMatchObject({
      posture: 'indeterminate',
      coherence: 'conflict',
    });
  });

  it('observes mixed live outcomes before filtering, sorting and cursor pagination', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'ls-uds-'));
    const servers: Server[] = [];
    const sockets: import('node:net').Socket[] = [];
    const listen = async (name: string, result: 'live' | 'unsupported' | 'timeout') => {
      const path = join(dir, name);
      const server = createServer((socket) => {
        sockets.push(socket);
        socket.on('data', () => {
          if (result === 'timeout') return;
          socket.end(JSON.stringify(result === 'live'
            ? { jsonrpc: '2.0', id: 1, result: { sequence: 0, openQuestions: [], workStatus: 'working', sessionState: { current: { statusLine: 'live', reportedAt: 100 }, history: [] } } }
            : { jsonrpc: '2.0', id: 1, error: { code: -32601, message: 'unsupported' } }) + '\n');
        });
      });
      await new Promise<void>((resolve, reject) => server.once('error', reject).listen(path, resolve));
      servers.push(server);
      return path;
    };
    try {
      const live = await listen('live', 'live');
      const unsupported = await listen('old', 'unsupported');
      const timeout = await listen('slow', 'timeout');
      const issue = 'https://github.com/example/project/issues/764';
      await writeResumeStore('live', 10, issue, { harnessPhase: 'close', harnessSocketPath: live, statusLine: 'saved' });
      await writeResumeStore('old', 20, issue, { harnessSocketPath: unsupported });
      await writeResumeStore('slow', 30, issue, { harnessSocketPath: timeout });
      await writeResumeStore('missing', 40, issue, { harnessSocketPath: join(dir, 'missing') });
      const tool = createListOperatorSessionsTool(repoRoot);
      const all = JSON.parse((await tool.execute({ includeGithub: false })).content[0]!.text);
      expect(all.sessions).toEqual(expect.arrayContaining([
        expect.objectContaining({ conductorAgentId: 'live', workStatus: expect.objectContaining({ status: 'working', source: 'uds', observedAt: expect.any(Number) }) }),
        expect.objectContaining({ conductorAgentId: 'live', statusLine: 'live', reportedAt: 100, statusLineSource: 'uds', openQuestionCount: 0, openQuestionCountSource: 'uds', persisted: expect.objectContaining({ harnessPhase: 'close' }), live: expect.objectContaining({ connectivity: 'reachable' }) }),
        expect.objectContaining({ conductorAgentId: 'missing', openQuestionCount: 1, live: expect.objectContaining({ connectivity: 'unreachable' }) }),
        expect.objectContaining({ conductorAgentId: 'old', live: expect.objectContaining({ connectivity: 'unknown' }) }),
        expect.objectContaining({ conductorAgentId: 'slow', live: expect.objectContaining({ connectivity: 'unknown' }) }),
      ]));
      const first = JSON.parse((await tool.execute({ includeGithub: false, liveConnectivity: 'unknown', hasOpenQuestions: true, sort: 'reportedAtDesc', limit: 1 })).content[0]!.text);
      expect(first.total).toBe(2);
      const second = JSON.parse((await tool.execute({ includeGithub: false, liveConnectivity: 'unknown', hasOpenQuestions: true, sort: 'reportedAtDesc', limit: 1, cursor: first.nextCursor })).content[0]!.text);
      expect(second.sessions[0].conductorAgentId).not.toBe(first.sessions[0].conductorAgentId);
      await expect(tool.execute({ liveConnectivity: 'reachable', sort: 'reportedAtDesc', cursor: first.nextCursor })).rejects.toThrow('cursor');
      const selected = JSON.parse((await tool.execute({ includeGithub: false, harnessPhase: 'close', minOpenQuestions: 0, reportedBefore: 1 })).content[0]!.text);
      expect(selected.sessions.map((item: { conductorAgentId: string }) => item.conductorAgentId)).toEqual(['live']);
    } finally {
      for (const socket of sockets) socket.destroy();
      await Promise.all(servers.map((server) => new Promise<void>((resolve) => server.close(() => resolve()))));
      await rm(dir, { recursive: true, force: true });
    }
  }, 15_000);

  it('limits concurrent observation requests to eight', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'ls-limit-'));
    const path = join(dir, 's');
    let active = 0;
    let maximum = 0;
    const server = createServer((socket) => {
      active++;
      maximum = Math.max(maximum, active);
      socket.once('close', () => active--);
      socket.once('data', () => setTimeout(() => socket.end(JSON.stringify({ jsonrpc: '2.0', id: 1, result: { sequence: 0, openQuestions: [] } }) + '\n'), 100));
    });
    await new Promise<void>((resolve, reject) => server.once('error', reject).listen(path, resolve));
    try {
      const issue = 'https://github.com/example/project/issues/766';
      for (let index = 0; index < 12; index++) await writeResumeStore(`limit-${index}`, index, issue, { harnessSocketPath: path });
      const result = JSON.parse((await createListOperatorSessionsTool(repoRoot).execute({ includeGithub: false })).content[0]!.text);
      expect(result.total).toBe(12);
      expect(result.sessions.every((item: { live: { connectivity: string } }) => item.live.connectivity === 'reachable')).toBe(true);
      expect(maximum).toBe(8);
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('keeps earlier live results and the saved read time across a long batch', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'ls-long-'));
    const issue = 'https://github.com/example/project/issues/768';
    let clock = Date.now();
    const start = clock;
    const dateSpy = vi.spyOn(Date, 'now').mockImplementation(() => clock);
    const servers: Server[] = [];
    const listen = async (name: string, handler: (socket: import('node:net').Socket) => void) => {
      const path = join(dir, name);
      const server = createServer(handler);
      await new Promise<void>((resolve, reject) => server.once('error', reject).listen(path, resolve));
      servers.push(server);
      return path;
    };
    try {
      const live = await listen('live', (socket) => socket.once('data', () => socket.end(JSON.stringify({ jsonrpc: '2.0', id: 1, result: { sequence: 0, openQuestions: [], sessionState: { current: { statusLine: 'live', reportedAt: 100 }, history: [] } } }) + '\n')));
      const saved = await listen('saved', (socket) => socket.once('data', () => setTimeout(async () => {
        clock = start + 11_000;
        const path = resolveEnsemblePaths({ repoRoot }).canonicalOpenQuestionsPath(issue, 'saved');
        await writeFile(path, 'version: 1\nsequence: 0\nopenQuestions: []\n');
        socket.end();
      }, 100)));
      await writeResumeStore('live', 10, issue, { harnessSocketPath: live });
      await writeResumeStore('watched-long', 15, issue, { harnessSocketPath: join(dir, 'missing') });
      await writeResumeStore('saved', 20, issue, { harnessSocketPath: saved });
      const path = resolveEnsemblePaths({ repoRoot }).canonicalOpenQuestionsPath(issue, 'saved');
      await mkdir(dirname(path), { recursive: true });
      await writeFile(path, 'version: 1\nsequence: 1\nopenQuestions:\n  - id: q\n    question: Test?\n    responseType: yes_no\n    source: conductor\n    status: open\n    askedAt: 1\n');
      const tool = createListOperatorSessionsTool(repoRoot, (id) => id === 'watched-long' ? { connectivity: 'reachable', checkedAt: start, unreachableSince: null, snapshot: { sequence: 0, openQuestions: [], sessionState: { current: { statusLine: 'watch', reportedAt: 50 }, history: [] } } } : undefined);
      const result = JSON.parse((await tool.execute({ includeGithub: false })).content[0]!.text);
      expect(result.sessions).toEqual(expect.arrayContaining([
        expect.objectContaining({ conductorAgentId: 'live', statusLine: 'live', openQuestionCount: 0, live: expect.objectContaining({ connectivity: 'unknown', lastKnownConnectivity: 'reachable', freshness: 'stale', ageMs: 11_000, checkedAt: start }) }),
        expect.objectContaining({ conductorAgentId: 'watched-long', statusLine: 'watch', live: expect.objectContaining({ connectivity: 'unknown', lastKnownConnectivity: 'reachable', freshness: 'stale', ageMs: 11_000, checkedAt: start }) }),
        expect.objectContaining({ conductorAgentId: 'saved', openQuestionCount: 1, openQuestionCountSource: 'open_questions_yaml', openQuestionCountObservedAt: start }),
      ]));
      const current = JSON.parse((await createListOperatorSessionsTool(repoRoot).execute({ includeGithub: false, conductorAgentId: 'saved' })).content[0]!.text);
      expect(current.sessions[0]).toMatchObject({ openQuestionCount: 0, openQuestionCountObservedAt: start + 11_000 });
    } finally {
      dateSpy.mockRestore();
      await Promise.all(servers.map((server) => new Promise<void>((resolve) => server.close(() => resolve()))));
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('retains a successful observation while more than ten seconds of timeouts complete', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'ls-timeouts-'));
    const issue = 'https://github.com/example/project/issues/771';
    const livePath = join(dir, 'live');
    const slowPath = join(dir, 'slow');
    const sockets: import('node:net').Socket[] = [];
    const live = createServer((socket) => socket.once('data', () => socket.end(JSON.stringify({ jsonrpc: '2.0', id: 1, result: { sequence: 0, openQuestions: [], sessionState: { current: { statusLine: 'early', reportedAt: 1 }, history: [] } } }) + '\n')));
    const slow = createServer((socket) => { sockets.push(socket); socket.on('error', () => {}); });
    await Promise.all([new Promise<void>((resolve, reject) => live.once('error', reject).listen(livePath, resolve)), new Promise<void>((resolve, reject) => slow.once('error', reject).listen(slowPath, resolve))]);
    try {
      await writeResumeStore('a-live', 9999, issue, { harnessSocketPath: livePath });
      for (let i = 0; i < 88; i++) await writeResumeStore(`z-${String(i).padStart(3, '0')}`, i + 2, issue, { harnessSocketPath: slowPath });
      const result = JSON.parse((await createListOperatorSessionsTool(repoRoot).execute({ includeGithub: false, liveConnectivity: 'unknown', sort: 'updatedAtDesc' })).content[0]!.text);
      expect(result.total).toBe(89);
      expect(result.sessions[0]).toMatchObject({ conductorAgentId: 'a-live', statusLine: 'early', openQuestionCount: 0, live: { connectivity: 'unknown', lastKnownConnectivity: 'reachable', freshness: 'stale' } });
      expect(result.sessions[0].live.ageMs).toBeGreaterThan(10_000);
    } finally {
      for (const socket of sockets) socket.destroy();
      await Promise.all([live, slow].map((server) => new Promise<void>((resolve) => server.close(() => resolve()))));
      await rm(dir, { recursive: true, force: true });
    }
  }, 25_000);

  it('checks watch freshness when a queued candidate is processed', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'ls-watch-age-'));
    const path = join(dir, 's');
    const issue = 'https://github.com/example/project/issues/769';
    let clock = Date.now();
    const start = clock;
    const dateSpy = vi.spyOn(Date, 'now').mockImplementation(() => clock);
    const server = createServer((socket) => socket.once('data', () => setTimeout(() => {
      clock = start + 12_000;
      socket.end(JSON.stringify({ jsonrpc: '2.0', id: 1, result: { sequence: 0, openQuestions: [], sessionState: { current: { statusLine: 'direct', reportedAt: 1 }, history: [] } } }) + '\n');
    }, 50)));
    await new Promise<void>((resolve, reject) => server.once('error', reject).listen(path, resolve));
    try {
      for (let i = 0; i < 9; i++) await writeResumeStore(`queued-${i}`, i, issue, { harnessSocketPath: path });
      const checkedIds: string[] = [];
      const tool = createListOperatorSessionsTool(repoRoot, (id) => {
        checkedIds.push(id);
        return { connectivity: 'reachable', checkedAt: start + 1_000, unreachableSince: null, snapshot: { sequence: 0, openQuestions: [], sessionState: { current: { statusLine: 'old watch', reportedAt: 1 }, history: [] } } };
      });
      const result = JSON.parse((await tool.execute({ includeGithub: false })).content[0]!.text);
      expect(checkedIds).toHaveLength(9);
      expect(result.sessions.find((entry: { conductorAgentId: string }) => entry.conductorAgentId === checkedIds[8])).toMatchObject({ statusLine: 'direct', statusLineSource: 'uds' });
    } finally {
      dateSpy.mockRestore();
      await new Promise<void>((resolve) => server.close(() => resolve()));
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('evaluates reportedBefore at dataAsOf for reports made during the listing and threshold crossings', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'ls-reported-age-'));
    const issue = 'https://github.com/example/project/issues/772';
    let clock = Date.now();
    const start = clock;
    const spy = vi.spyOn(Date, 'now').mockImplementation(() => clock);
    const servers: Server[] = [];
    const listen = async (name: string, reportedAt: number, delay: boolean) => {
      const path = join(dir, name);
      const server = createServer((socket) => socket.once('data', () => setTimeout(() => {
        if (delay) clock = start + 6_000;
        socket.end(JSON.stringify({ jsonrpc: '2.0', id: 1, result: { sequence: 0, openQuestions: [], sessionState: { current: { statusLine: name, reportedAt }, history: [] } } }) + '\n');
      }, delay ? 50 : 0)));
      await new Promise<void>((resolve, reject) => server.once('error', reject).listen(path, resolve));
      servers.push(server);
      return path;
    };
    try {
      await writeResumeStore('crossed', 10, issue, { harnessSocketPath: await listen('crossed', start + 1_000, false) });
      await writeResumeStore('young', 20, issue, { harnessSocketPath: await listen('young', start + 1_001, true) });
      const tool = createListOperatorSessionsTool(repoRoot);
      const result = JSON.parse((await tool.execute({ includeGithub: false, reportedBefore: 5_000 })).content[0]!.text);
      expect(Date.parse(result.dataAsOf)).toBe(start + 6_000);
      expect(result.sessions.map((item: { conductorAgentId: string }) => item.conductorAgentId)).toEqual(['crossed']);
      clock = start;
      const zero = JSON.parse((await tool.execute({ includeGithub: false, reportedBefore: 0 })).content[0]!.text);
      expect(zero.total).toBe(2);
    } finally {
      spy.mockRestore();
      await Promise.all(servers.map((server) => new Promise<void>((resolve) => server.close(() => resolve()))));
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('re-evaluates freshness and page after a slow GitHub lookup', async () => {
    let clock = Date.now();
    const start = clock;
    const spy = vi.spyOn(Date, 'now').mockImplementation(() => clock);
    try {
      await writeResumeStore('a', 20, 'https://github.com/example/project/issues/773');
      await writeResumeStore('b', 10, 'https://github.com/example/project/issues/774');
      const client = { getIssuePullRequestSummaries: async () => {
        clock = start + 11_000;
        return { status: 'available', pullRequests: [], pullRequestsTruncated: false };
      } } as unknown as GitHubClient;
      const tool = createListOperatorSessionsTool({ userEnsembleRoot: join(repoRoot, '.user-ensemble'), getGitHubClient: async () => client }, (id) => ({
        connectivity: 'reachable', checkedAt: start, unreachableSince: null,
        snapshot: { sequence: 0, openQuestions: [], sessionState: { current: { statusLine: id, reportedAt: id === 'a' ? start - 20_000 : start - 4_000 }, history: [] } },
      }));
      const result = JSON.parse((await tool.execute({ reportedBefore: 5_000, sort: 'updatedAtAsc', limit: 1 })).content[0]!.text);
      expect(result.total).toBe(2);
      expect(Date.parse(result.dataAsOf)).toBe(start + 11_000);
      expect(result.sessions[0]).toMatchObject({ conductorAgentId: 'b', statusLine: 'b', live: { connectivity: 'unknown', lastKnownConnectivity: 'reachable', freshness: 'stale', ageMs: 11_000 }, pullRequests: { status: 'not_checked', reason: 'page_changed_during_lookup' } });
      expect(result.nextCursor).toBeTruthy();
    } finally {
      spy.mockRestore();
    }
  });

  it('re-evaluates live filters when connectivity changes between pages', async () => {
    const issue = 'https://github.com/example/project/issues/770';
    for (const id of ['a', 'b', 'c']) await writeResumeStore(id, 10, issue);
    let disconnected = false;
    const tool = createListOperatorSessionsTool(repoRoot, (id) => ({
      connectivity: disconnected && id === 'b' ? 'unreachable' : 'reachable',
      checkedAt: Date.now(), unreachableSince: null,
      snapshot: { sequence: 0, openQuestions: [] },
    }));
    const first = JSON.parse((await tool.execute({ includeGithub: false, liveConnectivity: 'reachable', limit: 1 })).content[0]!.text);
    expect(first.sessions[0].conductorAgentId).toBe('a');
    disconnected = true;
    const second = JSON.parse((await tool.execute({ includeGithub: false, liveConnectivity: 'reachable', limit: 1, cursor: first.nextCursor })).content[0]!.text);
    expect(second.total).toBe(2);
    expect(second.sessions[0].conductorAgentId).toBe('c');
  });

  it('orders reportedAt in both directions with missing reports last', async () => {
    const issue = 'https://github.com/example/project/issues/767';
    await writeResumeStore('early', 10, issue, { statusLine: 'early' });
    await writeResumeStore('late', 20, issue, { statusLine: 'late' });
    await writeResumeStore('none', 30, issue);
    const tool = createListOperatorSessionsTool(repoRoot);
    for (const [sort, expected] of [
      ['reportedAtAsc', ['early', 'late', 'none']],
      ['reportedAtDesc', ['late', 'early', 'none']],
    ] as const) {
      const result = JSON.parse((await tool.execute({ sort, includeGithub: false })).content[0]!.text);
      expect(result.sessions.map((item: { conductorAgentId: string }) => item.conductorAgentId)).toEqual(expected);
    }
  });

  it('reuses a fresh watch snapshot without connecting to its recorded path', async () => {
    const issue = 'https://github.com/example/project/issues/765';
    await writeResumeStore('watched', 10, issue, { harnessSocketPath: join(tmpdir(), 'missing-watch-socket') });
    const checkedAt = Date.now();
    const tool = createListOperatorSessionsTool(repoRoot, () => ({ connectivity: 'reachable', checkedAt, unreachableSince: null, snapshot: { sequence: 0, openQuestions: [], sessionState: { current: { statusLine: 'watched', reportedAt: 42 }, history: [] } } }));
    const result = JSON.parse((await tool.execute({ includeGithub: false, liveConnectivity: 'reachable' })).content[0]!.text);
    expect(result.sessions[0]).toMatchObject({ statusLine: 'watched', statusLineObservedAt: checkedAt, openQuestionCount: 0, openQuestionCountObservedAt: checkedAt });
  });

  it('returns an empty result when this repository has no session directory', async () => {
    const emptyRepoRoot = await mkdtemp(join(tmpdir(), 'ensemble-empty-sessions-'));
    try {
      const result = await createListOperatorSessionsTool(emptyRepoRoot).execute({});
      expect(JSON.parse(result.content[0]!.text)).toMatchObject({
        total: 0,
        returned: 0,
        sessions: [],
      });
    } finally {
      await rm(emptyRepoRoot, { recursive: true, force: true });
    }
  });

  it('rejects invalid result limits', async () => {
    const tool = createListOperatorSessionsTool(repoRoot);

    await expect(tool.execute({ limit: 0 })).rejects.toThrow(
      'limit must be an integer between 1 and 50',
    );
    await expect(tool.execute({ limit: 1.5 })).rejects.toThrow(
      'limit must be an integer between 1 and 50',
    );
    await expect(tool.execute({ sort: 'oldest' })).rejects.toThrow(
      'sort must be firstObservedAtDesc, firstObservedAtAsc, updatedAtDesc, updatedAtAsc, reportedAtDesc, or reportedAtAsc',
    );
    await expect(tool.execute({ hasStatusLine: 'yes' })).rejects.toThrow(
      'hasStatusLine must be a boolean',
    );
    await expect(tool.execute({ lifecycle: 'running' })).rejects.toThrow(
      'lifecycle must be one of closed, exited, interrupted, unknown',
    );
  });

  async function writeResumeStore(
    agentId: string,
    updatedAt: number,
    issueUrl: string,
    options: {
      lifecycle?: 'closed' | 'exited' | 'interrupted' | 'unknown';
      harnessPhase?: 'running' | 'idle' | 'close' | 'abort' | 'exit';
      modifiedAt?: number;
      statusLine?: string;
      harnessSocketPath?: string;
    } = {},
  ): Promise<void> {
    const path = resolveEnsemblePaths({
      repoRoot,
    }).canonicalSessionResumeStorePath(issueUrl, agentId);
    await mkdir(dirname(path), { recursive: true });
    await writeFile(
      path,
      JSON.stringify({
        version: 1,
        conductorAgentId: agentId,
        ...(options.harnessSocketPath ? { harnessSocketPath: options.harnessSocketPath } : {}),
        issueUrl,
        repoRoot,
        ...(options.lifecycle ? { lifecycle: options.lifecycle } : {}),
        ...(options.harnessPhase
          ? { harnessPhase: options.harnessPhase }
          : {}),
        ...(options.modifiedAt !== undefined
          ? { modifiedAt: options.modifiedAt }
          : {}),
        profile: {
          meta: { title: 'Example team' },
          workers: [],
          agents: {},
        },
        openQuestions: [
          {
            id: 'inq-open',
            question: 'Should this proceed?',
            responseType: 'yes_no',
            source: 'conductor',
            status: 'open',
            askedAt: 1,
            context: 'An operation is waiting.',
            relatedPermissionId: 'permission-1',
          },
          {
            id: 'inq-answered',
            question: 'Use the requested option?',
            responseType: 'choice',
            source: 'conductor',
            status: 'answered',
            askedAt: 1,
            answer: 'Yes.',
          },
        ],
        sequence: 2,
        workers: { implementer: { acpSessionId: `${agentId}-worker` } },
        updatedAt,
      }),
    );
    if (options.statusLine) {
      const statePath = resolveEnsemblePaths({
        repoRoot,
      }).canonicalSessionStatePath(issueUrl, agentId);
      await mkdir(dirname(statePath), { recursive: true });
      await writeFile(
        statePath,
        `version: 1\nstatusLine: "${options.statusLine}"\nreportedAt: ${updatedAt + 1}\n`,
      );
    }
  }
});
