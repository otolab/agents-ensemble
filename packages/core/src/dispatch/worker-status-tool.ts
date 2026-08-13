import type { SDKCustomTool, SDKJsonValue } from '@cursor/sdk';
import yaml from 'js-yaml';
import type { WorkerRuntime } from '../runtime/worker-runtime.js';
import type { WorkerFailureRecord } from '../runtime/types.js';
import type {
  WorkerSessionStatusSummary,
  WorkerStatusDetail,
} from '../runtime/worker-status.js';

export interface WorkerStatusToolOptions {
  runtime: WorkerRuntime;
  workerNames: string[];
  getWorkerFailures: () => WorkerFailureRecord[];
}

export function createWorkerStatusTools(
  options: WorkerStatusToolOptions,
): Record<string, SDKCustomTool> {
  const workerEnum =
    options.workerNames.length > 0 ? options.workerNames : ['__none__'];

  return {
    list_workers: {
      description:
        'List attached workers and harness summary. Worker `state` uses lifecycle vocabulary (attaching/idle/processing/failed). TUI maps attaching|processing to display `running` (see mapHarnessToDisplayStatus). Includes queue depth and runningCount. Use for operator status questions — do not prompt_worker for status checks.',
      inputSchema: {
        type: 'object',
        properties: {},
      },
      async execute() {
        const summary = buildSessionSummary(options);
        return yamlToolResult('list_workers', summary);
      },
    },
    get_worker_status: {
      description:
        'Read one worker harness status in detail (`state` is lifecycle vocabulary: attaching/idle/processing/failed). Use after list_workers when you need queue preview or preempt/cancel flags.',
      inputSchema: {
        type: 'object',
        properties: {
          worker: {
            type: 'string',
            enum: workerEnum,
            description: 'Profile worker name (e.g. implementer, reviewer)',
          },
        },
        required: ['worker'],
      },
      async execute(args) {
        const worker = String(args.worker ?? '').trim();
        if (!worker) {
          throw new Error('get_worker_status requires worker');
        }

        const detail = options.runtime.getWorkerStatus(worker);
        if (!detail) {
          throw new Error(`get_worker_status: worker "${worker}" not found`);
        }

        const failures = options.getWorkerFailures();
        const failure = failures.find((entry) => entry.name === worker);
        const payload: WorkerStatusDetail & { lastFailure?: { error: string } } = {
          ...detail,
          ...(failure ? { lastFailure: { error: failure.error } } : {}),
        };

        return yamlToolResult('get_worker_status', payload);
      },
    },
  };
}

function buildSessionSummary(
  options: WorkerStatusToolOptions,
): WorkerSessionStatusSummary {
  const failures = options.getWorkerFailures();
  return {
    runningCount: options.runtime.runningCount,
    attachedCount: options.runtime.attachedCount,
    attachInFlight: options.runtime.attachInFlightCount,
    workerFailureCount: failures.length,
    workers: options.runtime.listWorkerStatuses(),
  };
}

function yamlToolResult(label: string, data: unknown) {
  const text = [
    '```yaml',
    `# ${label}`,
    yaml.dump(data, { lineWidth: 120 }).trimEnd(),
    '```',
  ].join('\n');

  return {
    content: [{ type: 'text' as const, text }],
    structuredContent: toStructuredContent(data),
  };
}

function toStructuredContent(data: unknown): Record<string, SDKJsonValue> {
  return JSON.parse(JSON.stringify(data)) as Record<string, SDKJsonValue>;
}
