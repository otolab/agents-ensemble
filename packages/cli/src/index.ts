#!/usr/bin/env node

import { Command } from 'commander';
import { PACKAGE_NAME } from '@agents-ensemble/core';

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
    console.error('core:', PACKAGE_NAME);
    process.exit(1);
  });

program.parse();
