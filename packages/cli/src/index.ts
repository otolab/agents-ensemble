#!/usr/bin/env node

import { resolve } from 'node:path';
import { Command } from 'commander';
import {
  dispatchWorker,
  getConductorAuthStatus,
  loginConductor,
  runIssueSession,
} from '@agents-ensemble/core';

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
  .action(
    async (
      issueUrl: string,
      options: {
        repoRoot: string;
        conductorCwd: string;
        resume?: string;
        briefing?: string;
      },
    ) => {
      try {
        const result = await runIssueSession({
          issueUrl,
          repoRoot: resolve(options.repoRoot),
          conductorCwd: resolve(options.conductorCwd),
          resumeAgentId: options.resume,
          briefing: options.briefing,
          onWorkerDispatched: (dispatch) => {
            console.error(
              `[worker dispatched] ${dispatch.worktree.path} (${dispatch.promptResult.stopReason})`,
            );
          },
        });

        console.log(
          JSON.stringify(
            {
              agentId: result.agentId,
              issueUrl: result.issueUrl,
              repoRoot: result.repoRoot,
              lastRunStatus: result.lastRunStatus,
              workerDispatchCount: result.workerDispatches.length,
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
      const result = await dispatchWorker({
        issueUrl,
        skillName: options.skill,
        repoRoot: resolve(options.repoRoot),
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

program.parse();
