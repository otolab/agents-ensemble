#!/usr/bin/env node

import { resolve } from 'node:path';
import { Command } from 'commander';
import { dispatchWorker } from '@agents-ensemble/core';

const program = new Command();

program
  .name('ensemble')
  .description('Issue-based agent orchestration')
  .version('0.0.0');

program
  .command('issue')
  .description('Start orchestration for a GitHub Issue')
  .argument('<target>', 'Issue URL or number (with --repo)')
  .option('--repo <owner/name>', 'Repository when target is an issue number')
  .action((target: string, options: { repo?: string }) => {
    console.error('Not implemented yet.');
    console.error('target:', target);
    if (options.repo) console.error('repo:', options.repo);
    process.exit(1);
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
