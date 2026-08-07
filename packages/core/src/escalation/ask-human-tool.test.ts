import { describe, expect, it, vi } from 'vitest';
import { createAskHumanTool } from './ask-human-tool.js';

describe('createAskHumanTool', () => {
  it('returns human answer to conductor', async () => {
    const onAsk = vi.fn().mockResolvedValue({
      answer: 'wait for human review',
      approved: undefined,
    });
    const onEscalated = vi.fn();
    const tools = createAskHumanTool({ onAsk, onEscalated });
    const result = await tools.ask_human.execute({
      question: 'Should we dispatch reviewer?',
      responseType: 'text',
      context: 'PR is ready',
    });

    expect(onAsk).toHaveBeenCalledWith({
      kind: 'escalation',
      question: 'Should we dispatch reviewer?',
      responseType: 'text',
      context: 'PR is ready',
    });
    expect(onEscalated).toHaveBeenCalledOnce();
    expect(result.structuredContent).toEqual({
      answer: 'wait for human review',
    });
  });

  it('defaults responseType to text', async () => {
    const onAsk = vi.fn().mockResolvedValue({ answer: 'ok' });
    const tools = createAskHumanTool({ onAsk });
    await tools.ask_human.execute({ question: 'Next step?' });
    expect(onAsk).toHaveBeenCalledWith(
      expect.objectContaining({ responseType: 'text' }),
    );
  });
});
