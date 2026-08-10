import type { SDKCustomTool } from '@cursor/sdk';
import type { WorkerOutboundQueue } from '../runtime/worker-outbound-queue.js';

export interface PromptWorkerToolOptions {
  outboundQueue: WorkerOutboundQueue;
  workerNames: string[];
}

export function createPromptWorkerTool(
  options: PromptWorkerToolOptions,
): Record<string, SDKCustomTool> {
  const workerEnum =
    options.workerNames.length > 0 ? options.workerNames : ['__none__'];

  return {
    prompt_worker: {
      description:
        'Send a work instruction to an attached worker. The worker receives it as a new ACP prompt turn. Issue/PR alone does not trigger workers.',
      inputSchema: {
        type: 'object',
        properties: {
          worker: {
            type: 'string',
            enum: workerEnum,
            description: 'Profile worker name (e.g. implementer, reviewer)',
          },
          instruction: {
            type: 'string',
            description: 'Work instruction for this round (Markdown allowed)',
          },
          preempt: {
            type: 'boolean',
            description:
              'If true, cancel the in-progress prompt turn and send this instruction immediately (default: queue when busy)',
          },
        },
        required: ['worker', 'instruction'],
      },
      async execute(args) {
        const worker = String(args.worker ?? '').trim();
        const instruction = String(args.instruction ?? '').trim();
        const preempt = args.preempt === true;
        if (!worker) {
          throw new Error('prompt_worker requires worker');
        }
        if (!instruction) {
          throw new Error('prompt_worker requires instruction');
        }

        const result = options.outboundQueue.enqueue(
          worker,
          instruction,
          preempt ? { preempt: true } : undefined,
        );
        if (result.status === 'error') {
          throw new Error(result.message ?? `prompt_worker failed for ${worker}`);
        }

        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify(result, null, 2),
            },
          ],
          structuredContent: {
            status: result.status,
            worker: result.worker,
            ...(result.position !== undefined
              ? { position: result.position }
              : {}),
            ...(result.message !== undefined ? { message: result.message } : {}),
            ...(preempt ? { preempt: true } : {}),
          },
        };
      },
    },
  };
}
