import { resolve } from 'node:path';
import type { SDKCustomTool } from '@cursor/sdk';
import type { SessionUpdateHandler } from '../acp/acp-client.js';
import type { SpawnAcpProcessOptions } from '../acp/acp-process.js';
import type { PermissionHandler, PromptResult } from '../acp/types.js';
import { allowOnce } from '../permission/permission-broker.js';
import { parsePermissionRequest } from '../permission/permission-request.js';
import { parseIssueUrl, type IssueRef } from '../issue/issue-ref.js';
import { buildReviewerPrompt } from '../prompt/build-reviewer-prompt.js';
import type { WorktreeRef } from '../worktree/worktree.js';
import { resolveWorkerWorktree } from '../worktree/worktree.js';
import {
  closeWorkerAcpSession,
  openWorkerAcpSession,
  runWorkerAcpPrompt,
  type ConnectWorkerAcpFn,
} from './worker-acp-session.js';

export interface ReviewerDispatchOptions {
  prUrl: string;
  skillName: string;
  /** 既存 reviewer worktree のパス。指定時は Issue 解決を行わない。 */
  worktreePath?: string;
  /** worktreePath が無い場合に既存 worktree を解決する Issue URL。 */
  issueUrl?: string;
  /** issueUrl から worktree を解決するときの git clone root。 */
  repoRoot?: string;
  spawn?: SpawnAcpProcessOptions;
  connectAcp?: ConnectWorkerAcpFn;
  onUpdate?: SessionUpdateHandler;
  permissionHandler?: PermissionHandler;
}

export interface ReviewerDispatchResult {
  prUrl: string;
  worktreePath: string;
  prompt: string;
  promptResult: PromptResult;
}

/**
 * Resolve reviewer permissions inside the one-shot dispatch turn.
 *
 * `dispatch_reviewer` runs as a synchronous conductor custom tool. Waiting for
 * the conductor's inbox would require another conductor turn while the
 * current `agent.send` is still waiting, so this path must resolve ACP
 * permission requests locally. The manual CLI can still inject its
 * interactive handler through `ReviewerDispatchOptions.permissionHandler`.
 */
export function createReviewerDispatchPermissionHandler(): PermissionHandler {
  return (params) => allowOnce(parsePermissionRequest(params));
}

/** reviewer を既存 worktree 上の独立 ACP session で一度だけ実行する。 */
export async function dispatchReviewer(
  options: ReviewerDispatchOptions,
): Promise<ReviewerDispatchResult> {
  const worktree = await resolveReviewerWorktree(options);
  const prompt = buildReviewerPrompt({
    prUrl: options.prUrl,
    skillName: options.skillName,
    worktreePath: worktree.path,
  });
  const permissionHandler =
    options.permissionHandler ?? createReviewerDispatchPermissionHandler();
  const session = await openWorkerAcpSession({
    issueUrl: worktree.issue.url,
    worktree,
    connectAcp: options.connectAcp,
    spawn: options.spawn,
    permissionHandler,
  });

  try {
    const promptResult = await runWorkerAcpPrompt(session, prompt, {
      permissionHandler,
      onUpdate: options.onUpdate,
    });
    return {
      prUrl: options.prUrl,
      worktreePath: worktree.path,
      prompt,
      promptResult,
    };
  } finally {
    await closeWorkerAcpSession(session);
  }
}

export interface ReviewerDispatchToolOptions {
  /** conductor session の repo root。tool の repoRoot 省略時に使う。 */
  repoRoot: string;
  spawn?: SpawnAcpProcessOptions;
  permissionHandler?: PermissionHandler;
  /** テスト用の dispatch 差し替え。 */
  dispatch?: typeof dispatchReviewer;
}

/** conductor に登録する reviewer dispatch customTool。 */
export function createReviewerDispatchTool(
  options: ReviewerDispatchToolOptions,
): Record<string, SDKCustomTool> {
  const runDispatch = options.dispatch ?? dispatchReviewer;
  const permissionHandler =
    options.permissionHandler ?? createReviewerDispatchPermissionHandler();

  return {
    dispatch_reviewer: {
      description:
        'Dispatch an independent reviewer ACP session for a PR. The reviewer joins an existing worker worktree and the session is closed after one prompt.',
      inputSchema: {
        type: 'object',
        properties: {
          prUrl: {
            type: 'string',
            description: 'GitHub PR URL',
          },
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
              'GitHub Issue URL used to resolve an existing worktree when worktreePath is omitted',
          },
          repoRoot: {
            type: 'string',
            description:
              'Local git clone root used with issueUrl (defaults to the conductor repo root)',
          },
        },
        required: ['prUrl', 'skillName'],
      },
      async execute(args) {
        const prUrl = requiredString(args, 'prUrl');
        const skillName = requiredString(args, 'skillName');
        const worktreePath = optionalString(args.worktreePath);
        const issueUrl = optionalString(args.issueUrl);
        if (!worktreePath && !issueUrl) {
          throw new Error(
            'dispatch_reviewer requires worktreePath or issueUrl with repoRoot',
          );
        }

        const result = await runDispatch({
          prUrl,
          skillName,
          worktreePath,
          issueUrl,
          repoRoot: optionalString(args.repoRoot) ?? options.repoRoot,
          spawn: options.spawn,
          permissionHandler,
        });
        const response = {
          prUrl: result.prUrl,
          worktree: result.worktreePath,
          stopReason: result.promptResult.stopReason,
        };

        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify(response, null, 2),
            },
          ],
          structuredContent: response,
        };
      },
    },
  };
}

async function resolveReviewerWorktree(
  options: ReviewerDispatchOptions,
): Promise<WorktreeRef> {
  const directPath = options.worktreePath?.trim();
  if (directPath) {
    return {
      path: resolve(directPath),
      branch: 'unknown',
      // The path-only API has no Issue metadata; ACP session handling does not
      // use this value, but WorktreeRef keeps it for shared worker infrastructure.
      issue: pathOnlyReviewIssue(options.prUrl),
    };
  }

  const issue = options.issueUrl
    ? parseIssueUrl(options.issueUrl)
    : undefined;
  if (!issue || !options.repoRoot) {
    throw new Error(
      'Reviewer dispatch requires worktreePath or issueUrl with repoRoot',
    );
  }

  const worktree = await resolveWorkerWorktree(options.repoRoot, issue);
  if (!worktree) {
    throw new Error(
      `Worker worktree not found for ${options.issueUrl}. Dispatch worker first.`,
    );
  }
  return worktree;
}

function pathOnlyReviewIssue(prUrl: string): IssueRef {
  return {
    owner: 'unknown',
    repo: 'unknown',
    number: 0,
    url: prUrl,
  };
}

function requiredString(args: Record<string, unknown>, name: string): string {
  const value = optionalString(args[name]);
  if (!value) {
    throw new Error(`dispatch_reviewer requires ${name}`);
  }
  return value;
}

function optionalString(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  return trimmed || undefined;
}
