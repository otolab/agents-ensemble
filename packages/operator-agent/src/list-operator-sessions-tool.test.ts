import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createListOperatorSessionsTool } from './list-operator-sessions-tool.js';

describe('list_operator_sessions', () => {
  let repoRoot = '';

  beforeEach(async () => {
    repoRoot = await mkdtemp(join(tmpdir(), 'ensemble-operator-sessions-'));
    await mkdir(join(repoRoot, '.ensemble', 'sessions'), { recursive: true });
  });

  afterEach(async () => {
    await rm(repoRoot, { recursive: true, force: true });
  });

  it('returns recent SessionResumeStore summaries with open-question and worker details', async () => {
    const issueUrl = 'https://github.com/example/project/issues/1';
    await writeResumeState('older', 10, issueUrl);
    await writeResumeState('newer', 20, issueUrl, {
      lifecycle: 'closed',
      statusLine: '実装中：レビュー待ち',
    });
    const tool = createListOperatorSessionsTool(repoRoot);

    const result = await tool.execute({ limit: 1 });
    const summary = JSON.parse(result.content[0]!.text) as {
      repoRoot: string;
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
        workers: string[];
        openQuestions: Array<{ id: string; question: string }>;
        answeredQuestionCount: number;
      }>;
    };

    expect(summary).toMatchObject({
      repoRoot,
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

  it('filters per conductor instance by statusLine and lifecycle and keeps legacy sessions unknown', async () => {
    const issueUrl = 'https://github.com/example/project/issues/1';
    await writeResumeState('legacy', 10, issueUrl);
    await writeResumeState('closed', 20, issueUrl, {
      lifecycle: 'closed',
      statusLine: 'CI 確認中',
    });
    await writeResumeState('exited', 30, issueUrl, { lifecycle: 'exited' });
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

  it('returns bounded statusLine history through the existing list tool', async () => {
    const issueUrl = 'https://github.com/example/project/issues/499';
    await writeResumeState('history', 30, issueUrl, {
      statusLine: '最新の報告',
    });
    await writeFile(
      join(
        repoRoot,
        '.ensemble',
        'sessions',
        'history',
        'session-state.yaml',
      ),
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
      'sort must be updatedAtDesc or updatedAtAsc',
    );
    await expect(tool.execute({ hasStatusLine: 'yes' })).rejects.toThrow(
      'hasStatusLine must be a boolean',
    );
    await expect(tool.execute({ lifecycle: 'running' })).rejects.toThrow(
      'lifecycle must be one of closed, exited, interrupted, unknown',
    );
  });

  async function writeResumeState(
    agentId: string,
    updatedAt: number,
    issueUrl: string,
    options: {
      lifecycle?: 'closed' | 'exited' | 'interrupted' | 'unknown';
      statusLine?: string;
    } = {},
  ): Promise<void> {
    await writeFile(
      join(repoRoot, '.ensemble', 'sessions', `${agentId}.json`),
      JSON.stringify({
        version: 1,
        conductorAgentId: agentId,
        issueUrl,
        repoRoot,
        ...(options.lifecycle ? { lifecycle: options.lifecycle } : {}),
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
      const stateDir = join(
        repoRoot,
        '.ensemble',
        'sessions',
        agentId,
      );
      await mkdir(stateDir, { recursive: true });
      await writeFile(
        join(stateDir, 'session-state.yaml'),
        `version: 1\nstatusLine: "${options.statusLine}"\nreportedAt: ${updatedAt + 1}\n`,
      );
    }
  }
});
