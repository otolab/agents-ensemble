import { describe, expect, it, vi } from 'vitest';
import { createAskHumanTool } from './ask-human-tool.js';
import { SessionDialogueLog } from './dialogue-log.js';
import { OpenQuestionRegistry } from './open-question.js';

describe('createAskHumanTool', () => {
  it('enqueues a question without blocking', async () => {
    const registry = new OpenQuestionRegistry();
    const dialogueLog = new SessionDialogueLog();
    const onEnqueued = vi.fn();
    const tools = createAskHumanTool({ registry, dialogueLog, onEnqueued });
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
    expect(dialogueLog.list()[0]?.kind).toBe('registry_update');
    expect(result.structuredContent).toEqual({
      id: 'inq-1',
      status: 'open',
    });
  });

  it('defaults responseType to text', async () => {
    const registry = new OpenQuestionRegistry();
    const dialogueLog = new SessionDialogueLog();
    const tools = createAskHumanTool({ registry, dialogueLog });
    await tools.ask_human.execute({ question: 'Next step?' });
    expect(registry.listOpen()[0]?.responseType).toBe('text');
  });
});
