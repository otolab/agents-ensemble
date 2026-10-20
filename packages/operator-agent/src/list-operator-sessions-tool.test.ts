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

  it('returns recent sidecar summaries with open-question and worker details', async () => {
    await writeSidecar('older', 10, 'https://github.com/example/project/issues/1');
    await writeSidecar('newer', 20, 'https://github.com/example/project/issues/2');
    const tool = createListOperatorSessionsTool(repoRoot);

    const result = await tool.execute({ limit: 1 });
    const summary = JSON.parse(result.content[0]!.text) as {
      repoRoot: string;
      total: number;
      returned: number;
      sessions: Array<{
        agentId: string;
        issueUrl: string;
        conductorBackend: string;
        workers: string[];
        openQuestions: Array<{ id: string; question: string }>;
        answeredQuestionCount: number;
      }>;
    };

    expect(summary).toMatchObject({
      repoRoot,
      total: 2,
      returned: 1,
      sessions: [
        {
          agentId: 'newer',
          issueUrl: 'https://github.com/example/project/issues/2',
          conductorBackend: 'cursor',
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
    expect(result.structuredContent).toMatchObject({
      total: 2,
      returned: 1,
    });
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
  });

  async function writeSidecar(
    agentId: string,
    updatedAt: number,
    issueUrl: string,
  ): Promise<void> {
    await writeFile(
      join(repoRoot, '.ensemble', 'sessions', `${agentId}.json`),
      JSON.stringify({
        version: 1,
        conductorAgentId: agentId,
        issueUrl,
        repoRoot,
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
  }
});
