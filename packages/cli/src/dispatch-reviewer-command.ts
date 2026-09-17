import { resolve } from 'node:path';
import { Command } from 'commander';
import {
  dispatchReviewer as defaultDispatchReviewer,
  PermissionBroker,
} from '@agents-ensemble/core';
import { promptPermissionDecision as defaultPromptPermissionDecision } from './prompt-permission.js';

export interface ReviewerDispatchCommandDependencies {
  /** Test seam for the CLI action; production uses the core dispatcher. */
  dispatchReviewer?: typeof defaultDispatchReviewer;
  /** Test seam for the manual permission prompt. */
  promptPermissionDecision?: typeof defaultPromptPermissionDecision;
  /** Test seam for the process exit path. */
  exit?: (code: number) => never;
}

/** Register `ensemble dispatch reviewer` on an existing Commander command. */
export function registerReviewerDispatchCommand(
  parent: Command,
  dependencies: ReviewerDispatchCommandDependencies = {},
): Command {
  const runDispatch =
    dependencies.dispatchReviewer ?? defaultDispatchReviewer;
  const askPermission =
    dependencies.promptPermissionDecision ?? defaultPromptPermissionDecision;
  const exit = dependencies.exit ?? ((code: number): never => process.exit(code));

  return parent
    .command('reviewer')
    .description('Dispatch a reviewer for a PR')
    .argument('<pr-url>', 'GitHub PR URL')
    .requiredOption('--skill <name>', 'Review Skill name for the reviewer')
    .option('--worktree-path <path>', 'Existing worker worktree path')
    .option('--issue-url <url>', 'Resolve worktree from Issue when path is omitted')
    .option(
      '--repo-root <path>',
      'Local git clone root (used with --issue-url)',
      process.cwd(),
    )
    .action(
      async (
        prUrl: string,
        options: {
          skill: string;
          worktreePath?: string;
          issueUrl?: string;
          repoRoot: string;
        },
      ) => {
        try {
          const permissionBroker = new PermissionBroker({
            onAsk: askPermission,
          });
          const result = await runDispatch({
            prUrl,
            skillName: options.skill,
            worktreePath: options.worktreePath,
            issueUrl: options.issueUrl,
            repoRoot: resolve(options.repoRoot),
            permissionHandler: permissionBroker.createHandler('manual-reviewer'),
          });

          console.log(
            JSON.stringify(
              {
                prUrl: result.prUrl,
                worktree: result.worktreePath,
                stopReason: result.promptResult.stopReason,
              },
              null,
              2,
            ),
          );
        } catch (error) {
          console.error(error instanceof Error ? error.message : error);
          exit(1);
        }
      },
    );
}
