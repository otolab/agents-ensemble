import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { OpenQuestionRegistry } from '../escalation/open-question.js';
import {
  loadOpenQuestionsStore,
  OPEN_QUESTIONS_STORE_VERSION,
  openQuestionsStorePath,
  saveOpenQuestionsStore,
} from './open-questions-store.js';

describe('open questions store', () => {
  let tempDir = '';

  afterEach(async () => {
    if (tempDir) await rm(tempDir, { recursive: true, force: true });
    tempDir = '';
  });

  it('round-trips the registry snapshot and preserves sequence for future IDs', async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'ensemble-open-questions-'));
    const path = openQuestionsStorePath({
      repoRoot: tempDir,
      conductorAgentId: 'agent-1',
    });
    const snapshot = {
      sequence: 4,
      openQuestions: [
        {
          id: 'inq-4',
          question: 'Which deployment target?',
          responseType: 'choice' as const,
          choices: [
            { id: 'staging', label: 'Staging' },
            { id: 'production', label: 'Production' },
          ],
          context: 'Release is ready.',
          source: 'conductor' as const,
          status: 'answered' as const,
          askedAt: 1_735_689_600_000,
          answer: 'Production',
          selectedChoice: 'production',
          answeredAt: 1_735_689_601_000,
          answeredBy: 'operator' as const,
          sourceMessage: 'Ship it.',
          rationale: 'All checks passed.',
        },
      ],
    };

    await saveOpenQuestionsStore(path, snapshot);

    expect(await loadOpenQuestionsStore(path)).toEqual(snapshot);
    expect(await readFile(path, 'utf8')).toContain(
      `version: ${OPEN_QUESTIONS_STORE_VERSION}`,
    );

    const restored = new OpenQuestionRegistry();
    restored.restore((await loadOpenQuestionsStore(path))!);
    expect(
      restored.enqueue({
        question: 'Next question',
        responseType: 'text',
      }).id,
    ).toBe('inq-5');
  });

  it('preserves question IDs without the registry-generated inq-N form', async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'ensemble-open-questions-'));
    const path = openQuestionsStorePath({
      repoRoot: tempDir,
      conductorAgentId: 'agent-custom-id',
    });
    const snapshot = {
      sequence: 8,
      openQuestions: [
        {
          id: 'inq-yaml-8',
          question: 'Question from a stored snapshot',
          responseType: 'text' as const,
          source: 'conductor' as const,
          status: 'open' as const,
          askedAt: 1,
        },
      ],
    };

    await saveOpenQuestionsStore(path, snapshot);

    await expect(loadOpenQuestionsStore(path)).resolves.toEqual(snapshot);
  });

  it('returns undefined when the YAML store does not exist', async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'ensemble-open-questions-'));

    await expect(
      loadOpenQuestionsStore(
        openQuestionsStorePath({
          repoRoot: tempDir,
          conductorAgentId: 'missing-agent',
        }),
      ),
    ).resolves.toBeUndefined();
  });

  it('rejects unsupported versions and malformed questions', async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'ensemble-open-questions-'));
    const path = openQuestionsStorePath({
      repoRoot: tempDir,
      conductorAgentId: 'agent-invalid',
    });
    await mkdir(dirname(path), { recursive: true });

    await writeFile(
      path,
      'version: 2\nsequence: 0\nopenQuestions: []\n',
      'utf8',
    );
    await expect(loadOpenQuestionsStore(path)).rejects.toThrow(
      /Unsupported open questions YAML version: 2/,
    );

    await writeFile(
      path,
      'version: 1\nsequence: 0\nopenQuestions:\n  - id: inq-1\n',
      'utf8',
    );
    await expect(loadOpenQuestionsStore(path)).rejects.toThrow(
      /openQuestions\[0\]\.question/,
    );
  });

  it('rejects a sequence behind an existing question ID before restore can overwrite it', async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'ensemble-open-questions-'));
    const path = openQuestionsStorePath({
      repoRoot: tempDir,
      conductorAgentId: 'agent-sequence-mismatch',
    });
    await mkdir(dirname(path), { recursive: true });
    await writeFile(
      path,
      [
        'version: 1',
        'sequence: 1',
        'openQuestions:',
        '  - id: inq-2',
        '    question: Existing question',
        '    responseType: text',
        '    status: open',
        '    source: conductor',
        '    askedAt: 1',
      ].join('\n'),
      'utf8',
    );

    await expect(loadOpenQuestionsStore(path)).rejects.toThrow(
      /sequence is behind question id inq-2/,
    );
  });

  it('rejects duplicate IDs that would overwrite each other during restore', async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'ensemble-open-questions-'));
    const path = openQuestionsStorePath({
      repoRoot: tempDir,
      conductorAgentId: 'agent-duplicate-id',
    });
    await mkdir(dirname(path), { recursive: true });
    await writeFile(
      path,
      [
        'version: 1',
        'sequence: 1',
        'openQuestions:',
        '  - id: inq-1',
        '    question: First question',
        '    responseType: text',
        '    status: open',
        '    source: conductor',
        '    askedAt: 1',
        '  - id: inq-1',
        '    question: Second question',
        '    responseType: text',
        '    status: open',
        '    source: conductor',
        '    askedAt: 2',
      ].join('\n'),
      'utf8',
    );

    await expect(loadOpenQuestionsStore(path)).rejects.toThrow(
      /duplicate id inq-1/,
    );
  });
});
