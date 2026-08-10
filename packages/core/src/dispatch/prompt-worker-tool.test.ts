import { describe, expect, it, vi } from 'vitest';
import { WorkerOutboundQueue } from '../runtime/worker-outbound-queue.js';
import { createPromptWorkerTool } from './prompt-worker-tool.js';

describe('createPromptWorkerTool', () => {
  it('sends instruction via outbound queue', async () => {
    const enqueue = vi.fn().mockReturnValue({
      status: 'sent',
      worker: 'implementer',
    });
    const outboundQueue = new WorkerOutboundQueue(enqueue);
    const tools = createPromptWorkerTool({
      outboundQueue,
      workerNames: ['implementer', 'reviewer'],
    });

    const result = await tools.prompt_worker.execute({
      worker: 'implementer',
      instruction: 'Fix the failing test',
    });

    expect(enqueue).toHaveBeenCalledWith('implementer', 'Fix the failing test');
    expect(result.structuredContent).toEqual({
      status: 'sent',
      worker: 'implementer',
    });
  });

  it('throws when outbound queue returns error', async () => {
    const outboundQueue = new WorkerOutboundQueue(() => ({
      status: 'error',
      worker: 'unknown',
      message: 'Worker "unknown" is not attached',
    }));
    const tools = createPromptWorkerTool({
      outboundQueue,
      workerNames: ['implementer'],
    });

    await expect(
      tools.prompt_worker.execute({
        worker: 'unknown',
        instruction: 'nope',
      }),
    ).rejects.toThrow('not attached');
  });
});
