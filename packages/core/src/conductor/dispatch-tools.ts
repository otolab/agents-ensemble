import type { SDKCustomTool } from '@cursor/sdk';
import { dispatchWorker, type WorkerDispatchResult } from '../dispatch/worker-dispatch.js';

export interface DispatchToolsOptions {
  /** Default local clone for worker dispatch. */
  repoRoot: string;
  onWorkerDispatched?: (result: WorkerDispatchResult) => void;
}

export function createDispatchTools(
  options: DispatchToolsOptions,
): Record<string, SDKCustomTool> {
  return {
    dispatch_worker: {
      description:
        'Dispatch a worker agent (ACP) for the given GitHub Issue. Creates a worktree and runs the specified Skill.',
      inputSchema: {
        type: 'object',
        properties: {
          issueUrl: {
            type: 'string',
            description: 'GitHub Issue URL',
          },
          skillName: {
            type: 'string',
            description: 'Skill name for the worker to follow',
          },
          repoRoot: {
            type: 'string',
            description:
              'Local path to the target git clone. Defaults to the session repo root.',
          },
        },
        required: ['issueUrl', 'skillName'],
      },
      async execute(args) {
        const issueUrl = String(args.issueUrl ?? '');
        const skillName = String(args.skillName ?? '');
        const repoRoot = String(args.repoRoot ?? options.repoRoot);

        const result = await dispatchWorker({
          issueUrl,
          skillName,
          repoRoot,
        });
        options.onWorkerDispatched?.(result);

        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify(
                {
                  issue: result.issue.url,
                  worktree: result.worktree.path,
                  branch: result.worktree.branch,
                  stopReason: result.promptResult.stopReason,
                },
                null,
                2,
              ),
            },
          ],
          structuredContent: {
            issueUrl: result.issue.url,
            worktree: result.worktree.path,
            branch: result.worktree.branch,
            stopReason: result.promptResult.stopReason,
          },
        };
      },
    },

    dispatch_reviewer: {
      description:
        'Dispatch a reviewer agent for a PR (Stage 3). Skeleton: returns not implemented.',
      inputSchema: {
        type: 'object',
        properties: {
          prUrl: { type: 'string' },
          skillName: { type: 'string' },
          worktreePath: { type: 'string' },
        },
        required: ['prUrl', 'skillName', 'worktreePath'],
      },
      async execute() {
        return {
          content: [
            {
              type: 'text',
              text: 'dispatch_reviewer is not implemented yet (Stage 3).',
            },
          ],
          isError: true,
        };
      },
    },
  };
}
