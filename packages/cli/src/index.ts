#!/usr/bin/env node

import { readFile } from 'node:fs/promises';
import { basename, resolve } from 'node:path';
import { Command } from 'commander';
import {
  dispatchReviewer,
  dispatchWorker,
  getConductorAuthStatus,
  loginConductor,
  PermissionBroker,
  runIssueSession,
  type ConductorMaterial,
} from '@agents-ensemble/core';
import { promptHumanInquiry } from './prompt-human-inquiry.js';
import { promptPermissionDecision } from './prompt-permission.js';

const program = new Command();

program
  .name('ensemble')
  .description('Issue-based agent orchestration')
  .version('0.0.0');

program
  .command('issue')
  .description('Start conductor orchestration for a GitHub Issue')
  .argument('<issue-url>', 'GitHub Issue URL')
  .option(
    '--repo-root <path>',
    'Path to the local git clone for worker worktrees',
    process.cwd(),
  )
  .option(
    '--conductor-cwd <path>',
    'Workspace for the conductor SDK agent',
    process.cwd(),
  )
  .option('--resume <agentId>', 'Resume a previous conductor agent')
  .option('--briefing <text>', 'Optional briefing document for the conductor')
  .option(
    '--material <path>',
    'Reference document passed as material (repeatable)',
    collectValues,
    [],
  )
  .option('--model <id>', 'Conductor model id (default: composer-2.5)')
  .option(
    '--max-turns <n>',
    'Maximum conductor turns (default: 5)',
    (value) => Number.parseInt(value, 10),
    5,
  )
  .action(
    async (
      issueUrl: string,
      options: {
        repoRoot: string;
        conductorCwd: string;
        resume?: string;
        briefing?: string;
        material: string[];
        model?: string;
        maxTurns: number;
      },
    ) => {
      try {
        const materials = await loadMaterialFiles(options.material);
        const result = await runIssueSession({
          issueUrl,
          repoRoot: resolve(options.repoRoot),
          conductorCwd: resolve(options.conductorCwd),
          resumeAgentId: options.resume,
          briefing: options.briefing,
          materials,
          modelId: options.model,
          maxTurns: options.maxTurns,
          onHumanInquiry: promptHumanInquiry,
          onPermissionAsk: promptPermissionDecision,
          onEscalated: (record) => {
            console.error(`[human escalation] ${record.question} → ${record.answer}`);
          },
          onWorkerDispatched: (dispatch) => {
            console.error(
              `[worker dispatched] ${dispatch.worktree.path} (${dispatch.promptResult.stopReason})`,
            );
          },
          onWorkerFailed: (failure) => {
            console.error(
              `[worker failed] ${failure.workerId} ${failure.issueUrl} (${failure.skillName}): ${failure.error}`,
            );
          },
          onReviewerDispatched: (dispatch) => {
            console.error(
              `[reviewer dispatched] ${dispatch.worktreePath} (${dispatch.promptResult.stopReason})`,
            );
          },
          onTurnComplete: (turn) => {
            console.error(
              `[conductor turn ${turn.turn}] status=${turn.status} workerStarts=${turn.workerDispatchStarts} workerDone=${turn.workerDispatches} workerFailed=${turn.workerFailures} reviewer=${turn.reviewerDispatches} escalations=${turn.escalations}`,
            );
          },
        });

        console.log(
          JSON.stringify(
            {
              agentId: result.agentId,
              issueUrl: result.issueUrl,
              repoRoot: result.repoRoot,
              turnCount: result.turnCount,
              stopReason: result.stopReason,
              lastRunStatus: result.lastRunStatus,
              lastResult: result.lastResult,
              lastError: result.lastError,
              workerDispatchCount: result.workerDispatches.length,
              reviewerDispatchCount: result.reviewerDispatches.length,
              escalationCount: result.escalations.length,
            },
            null,
            2,
          ),
        );

        if (result.lastRunStatus === 'error') {
          process.exit(2);
        }
      } catch (error) {
        console.error(error instanceof Error ? error.message : error);
        process.exit(1);
      }
    },
  );

const auth = program.command('auth').description('Conductor (SDK) authentication');

auth
  .command('login')
  .description(
    'Browser login for conductor. Stores credentials in ~/.cursor/sdk/auth.json',
  )
  .action(async () => {
    try {
      const result = await loginConductor();
      const who = result.email ?? 'unknown';
      console.log(`Logged in as ${who}`);
      console.log(`API key expires: ${new Date(result.apiKeyExpiresAtMs).toISOString()}`);
    } catch (error) {
      console.error(error instanceof Error ? error.message : error);
      process.exit(1);
    }
  });

auth
  .command('status')
  .description('Show conductor (SDK) authentication status')
  .action(async () => {
    try {
      const status = await getConductorAuthStatus();
      if (status.status === 'logged-in') {
        const who = status.email ?? 'unknown';
        const expires = status.apiKeyExpiresAtMs
          ? new Date(status.apiKeyExpiresAtMs).toISOString()
          : 'unknown';
        console.log(`SDK: logged in as ${who} (expires ${expires})`);
      } else {
        console.log('SDK: logged out');
      }

      if (process.env.CURSOR_API_KEY) {
        console.log('CURSOR_API_KEY: set');
      } else {
        console.log('CURSOR_API_KEY: unset');
      }
    } catch (error) {
      console.error(error instanceof Error ? error.message : error);
      process.exit(1);
    }
  });

const dispatch = program
  .command('dispatch')
  .description('Dispatch a worker or reviewer without conductor');

dispatch
  .command('worker')
  .description('Dispatch a worker for a GitHub Issue (Stage 1 manual flow)')
  .argument('<issue-url>', 'GitHub Issue URL')
  .requiredOption('--skill <name>', 'Skill name for the worker')
  .option(
    '--repo-root <path>',
    'Path to the local git clone to work in',
    process.cwd(),
  )
  .action(async (issueUrl: string, options: { skill: string; repoRoot: string }) => {
    try {
      const permissionBroker = new PermissionBroker({
        onAsk: promptPermissionDecision,
      });
      const result = await dispatchWorker({
        issueUrl,
        skillName: options.skill,
        repoRoot: resolve(options.repoRoot),
        permissionHandler: permissionBroker.createHandler('manual-worker'),
        onUpdate: (update) => {
          const text = update.update?.content?.text;
          if (text) process.stderr.write(text);
        },
      });

      console.log(
        JSON.stringify(
          {
            issue: result.issue.url,
            worktree: result.worktree.path,
            branch: result.worktree.branch,
            stopReason: result.promptResult.stopReason,
          },
          null,
          2,
        ),
      );
    } catch (error) {
      console.error(error instanceof Error ? error.message : error);
      process.exit(1);
    }
  });

dispatch
  .command('reviewer')
  .description('Dispatch a reviewer for a PR (Stage 3 manual flow)')
  .argument('<pr-url>', 'GitHub PR URL')
  .requiredOption('--skill <name>', 'Review Skill name for the reviewer')
  .option('--worktree-path <path>', 'Existing worker worktree path')
  .option('--issue-url <url>', 'Resolve worktree from Issue when path omitted')
  .option(
    '--repo-root <path>',
    'Local git clone root (required with --issue-url)',
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
          onAsk: promptPermissionDecision,
        });
        const result = await dispatchReviewer({
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
        process.exit(1);
      }
    },
  );

program.parse();

function collectValues(value: string, previous: string[]): string[] {
  return [...previous, value];
}

async function loadMaterialFiles(paths: string[]): Promise<ConductorMaterial[]> {
  return Promise.all(
    paths.map(async (filePath) => {
      const absolutePath = resolve(filePath);
      const content = await readFile(absolutePath, 'utf8');
      const fileName = basename(absolutePath);
      return {
        id: fileName,
        title: fileName,
        content,
      };
    }),
  );
}
