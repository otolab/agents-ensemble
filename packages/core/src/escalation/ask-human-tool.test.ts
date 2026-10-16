import { describe, expect, it, vi } from 'vitest';
import { createAskHumanTool } from './ask-human-tool.js';
import { OpenQuestionRegistry } from './open-question.js';

describe('createAskHumanTool', () => {
  it('enqueues a question without blocking', async () => {
    const registry = new OpenQuestionRegistry();
    const onEnqueued = vi.fn();
    const tools = createAskHumanTool({ registry, onEnqueued });
    const result = await tools.ask_human.execute({
      question: 'Should we dispatch reviewer?',
      responseType: 'text',
      context: 'PR is ready',
    });

    expect(onEnqueued).toHaveBeenCalledOnce();
    expect(registry.listOpen()).toHaveLength(1);
    expect(registry.listOpen()[0]).toMatchObject({
      id: 'inq-1',
      question: 'Should we dispatch reviewer?',
      responseType: 'text',
      context: 'PR is ready',
      status: 'open',
    });
    expect(result.structuredContent).toEqual({
      id: 'inq-1',
      status: 'open',
    });
  });

  it('adds the linked pending permission summary to Open Question context', async () => {
    const registry = new OpenQuestionRegistry();
    const summary =
      'permission.pending worker=implementer tool=Edit path=src/example.ts id=perm-123...';
    const tools = createAskHumanTool({
      registry,
      getPermissionSummary: (permissionId) =>
        permissionId === 'permission-request-123456' ? summary : undefined,
    });

    await tools.ask_human.execute({
      question: 'Should I allow this edit?',
      responseType: 'yes_no',
      context: 'The operator should decide.',
      relatedPermissionId: 'permission-request-123456',
    });

    expect(registry.listOpen()[0]).toMatchObject({
      relatedPermissionId: 'permission-request-123456',
      context: `${summary}\nThe operator should decide.`,
    });
  });

  it('does not duplicate a summary the conductor already quoted in context', async () => {
    const registry = new OpenQuestionRegistry();
    const summary =
      'permission.pending worker=implementer tool=Edit path=src/example.ts id=perm-123...';
    const tools = createAskHumanTool({
      registry,
      getPermissionSummary: () => summary,
    });

    await tools.ask_human.execute({
      question: 'Should I allow this edit?',
      context: `Please decide:\n${summary}`,
      relatedPermissionId: 'permission-request-123456',
    });

    expect(registry.listOpen()[0]?.context).toBe(
      `Please decide:\n${summary}`,
    );
  });

  it('defaults responseType to text', async () => {
    const registry = new OpenQuestionRegistry();
    const tools = createAskHumanTool({ registry });
    await tools.ask_human.execute({ question: 'Next step?' });
    expect(registry.listOpen()[0]?.responseType).toBe('text');
  });

  it('enqueues a choice question with options', async () => {
    const registry = new OpenQuestionRegistry();
    const tools = createAskHumanTool({ registry });
    await tools.ask_human.execute({
      question: 'Which approach?',
      responseType: 'choice',
      choices: [
        { id: 'A', label: 'Ship now' },
        { id: 'B', label: 'Wait for review' },
      ],
    });

    expect(registry.listOpen()[0]).toMatchObject({
      responseType: 'choice',
      choices: [
        { id: 'A', label: 'Ship now' },
        { id: 'B', label: 'Wait for review' },
      ],
    });
  });

  it('requires options for a choice question', async () => {
    const tools = createAskHumanTool({ registry: new OpenQuestionRegistry() });
    await expect(
      tools.ask_human.execute({
        question: 'Which approach?',
        responseType: 'choice',
      }),
    ).rejects.toThrow('requires non-empty choices');
  });
});
