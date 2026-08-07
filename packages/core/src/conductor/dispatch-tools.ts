import type { SDKCustomTool, SDKCustomToolResult } from '@cursor/sdk';
import type { PermissionHandler } from '../acp/types.js';
import { dispatchReviewer, type ReviewerDispatchResult } from '../dispatch/reviewer-dispatch.js';
import { dispatchWorker, type WorkerDispatchResult } from '../dispatch/worker-dispatch.js';
import type { WorkerRuntime } from '../runtime/worker-runtime.js';
import type { WorkerStartedInfo } from '../runtime/types.js';

export interface DispatchToolsOptions {
  /** Default local clone for worker dispatch. */
  repoRoot: string;
  permissionHandler?: PermissionHandler;
  workerRuntime?: WorkerRuntime;
  onWorkerStarted?: (info: WorkerStartedInfo) => void;
  onWorkerDispatched?: (result: WorkerDispatchResult) => void;
  onReviewerDispatched?: (result: ReviewerDispatchResult) => void;
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
      async execute(args): Promise<SDKCustomToolResult> {
        const issueUrl = String(args.issueUrl ?? '');
        const skillName = String(args.skillName ?? '');
        const repoRoot = String(args.repoRoot ?? options.repoRoot);

        if (options.workerRuntime) {
          const workerId = options.workerRuntime.start({
            issueUrl,
            skillName,
            repoRoot,
          });
          const started = { workerId, issueUrl, skillName, repoRoot };
          options.onWorkerStarted?.(started);

          return {
            content: [
              {
                type: 'text',
                text: JSON.stringify(
                  {
                    workerId,
                    status: 'running',
                    issueUrl,
                    skillName,
                  },
                  null,
                  2,
                ),
              },
            ],
            structuredContent: {
              workerId,
              status: 'running',
              issueUrl,
              skillName,
            },
          };
        }

        const result = await dispatchWorker({
          issueUrl,
          skillName,
          repoRoot,
          permissionHandler: options.permissionHandler,
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
        'Dispatch a reviewer agent for a PR. Uses an existing worker worktree (context 0 review session).',
      inputSchema: {
        type: 'object',
        properties: {
          prUrl: { type: 'string', description: 'GitHub PR URL' },
          skillName: {
            type: 'string',
            description: 'Review Skill name for the reviewer',
          },
          worktreePath: {
            type: 'string',
            description: 'Existing worker worktree path',
          },
          issueUrl: {
            type: 'string',
            description:
              'GitHub Issue URL to resolve worktree when worktreePath is omitted',
          },
          repoRoot: {
            type: 'string',
            description:
              'Local git clone root when resolving worktree from issueUrl',
          },
        },
        required: ['prUrl', 'skillName'],
      },
      async execute(args) {
        const prUrl = String(args.prUrl ?? '');
        const skillName = String(args.skillName ?? '');
        const worktreePath = args.worktreePath
          ? String(args.worktreePath)
          : undefined;
        const issueUrl = args.issueUrl ? String(args.issueUrl) : undefined;
        const repoRoot = args.repoRoot
          ? String(args.repoRoot)
          : options.repoRoot;

        const result = await dispatchReviewer({
          prUrl,
          skillName,
          worktreePath,
          issueUrl,
          repoRoot,
          permissionHandler: options.permissionHandler,
        });

        options.onReviewerDispatched?.(result);

        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify(
                {
                  prUrl: result.prUrl,
                  worktree: result.worktreePath,
                  stopReason: result.promptResult.stopReason,
                },
                null,
                2,
              ),
            },
          ],
          structuredContent: {
            prUrl: result.prUrl,
            worktree: result.worktreePath,
            stopReason: result.promptResult.stopReason,
          },
        };
      },
    },
  };
}
