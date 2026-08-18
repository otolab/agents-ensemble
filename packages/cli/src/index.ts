#!/usr/bin/env node

import { resolve } from 'node:path';
import { Command } from 'commander';
import {
  getConductorAuthStatus,
  listConductorModels,
  loginConductor,
  logoutConductor,
  resolveIssueUrl,
} from '@agents-ensemble/core';
import { readCliPackageVersion } from './cli-version.js';
import { executeIssueCommand } from './issue-command.js';
import { formatModelsListJson, formatModelsListText } from './format-models-list.js';
import { isOperatorInputTty } from './prompt-operator-input.js';
import { resolveIssueSummaryFormat } from './resolve-summary-format.js';
import { writeIssueSessionSummary } from './write-issue-session-summary.js';
import { formatProfilesListJson, formatProfilesListText } from './format-profiles-list.js';

const program = new Command();

program
  .name('ensemble')
  .description('Issue-based agent orchestration')
  .version(readCliPackageVersion());

program
  .command('issue')
  .description('Start conductor orchestration for a GitHub Issue')
  .argument(
    '<issue-url>',
    'GitHub Issue URL or number (e.g. 31, #31)',
  )
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
  .option(
    '--continue',
    'Resume the latest session for this issue (uses sidecar with newest updatedAt)',
  )
  .option(
    '--profile <name>',
    'Team profile name or path (default: ENSEMBLE_DEFAULT_PROFILE env, else bundled implementer-and-reviewer). Name resolves: project .ensemble/teams/ > ~/.ensemble/teams/ > bundled > legacy profiles/',
  )
  .option('--model <id>', 'Conductor model id (default: default)')
  .option(
    '--max-turns <n>',
    'Maximum conductor autonomous turns (0 = unlimited; default: unlimited on TTY, 5 otherwise)',
    (value) => Number.parseInt(value, 10),
  )
  .option('--no-max-turns', 'Disable autonomous turn limit')
  .option(
    '--no-wait',
    'Exit immediately when the autonomous loop completes (TTY default: wait for /exit)',
  )
  .option(
    '--worktree <mode>',
    'Worker workspace: isolated (default, per-issue worktree) or in-repo (main worktree)',
    'isolated',
  )
  .option(
    '--default-acp-cli <preset>',
    'Default ACP CLI preset for workers without profile acp (cursor | claude | codex)',
  )
  .option(
    '--default-acp-command <cmd>',
    'Default custom ACP command (profile acp unset workers only; overrides --default-acp-cli)',
  )
  .option(
    '--default-acp-arg <arg>',
    'Additional arg for --default-acp-command (repeatable)',
    (value: string, previous: string[] | undefined) => [...(previous ?? []), value],
  )
  .option(
    '--no-github-monitor',
    'Disable GitHub Issue / PR update monitoring',
  )
  .option(
    '--github-monitor-debounce-ms <n>',
    'Debounce interval for GitHub update notifications (default: 30000)',
    (value) => Number.parseInt(value, 10),
  )
  .option(
    '--summary-format <format>',
    'Exit summary format: auto (TTY=text, non-TTY=json), json, or text',
    'auto',
  )
  .option(
    '--include-full-response-text',
    'Include full worker responseText in JSON exit summary (default: responsePreview only)',
  )
  .action(
    async (
      issueRef: string,
      options: {
        repoRoot: string;
        conductorCwd: string;
        resume?: string;
        continue?: boolean;
        profile?: string;
        model?: string;
        maxTurns?: number;
        noMaxTurns?: boolean;
        noWait?: boolean;
        worktree: string;
        defaultAcpCli?: string;
        defaultAcpCommand?: string;
        defaultAcpArg?: string[];
        githubMonitor?: boolean;
        githubMonitorDebounceMs?: number;
        summaryFormat?: string;
        includeFullResponseText?: boolean;
      },
    ) => {
      try {
        const repoRoot = resolve(options.repoRoot);
        const issueUrl = await resolveIssueUrl(issueRef, repoRoot);
        const result = await executeIssueCommand(issueUrl, {
          ...options,
          defaultAcpArgs: options.defaultAcpArg,
        });

        writeIssueSessionSummary(result, {
          format: resolveIssueSummaryFormat({
            summaryFormat: options.summaryFormat,
            isTty: isOperatorInputTty(),
          }),
          jsonOptions: {
            includeFullResponseText: options.includeFullResponseText,
          },
        });

        if (result.stopReason === 'error') {
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
  .command('logout')
  .description(
    'Clear stored conductor (SDK) credentials from ~/.cursor/sdk/auth.json',
  )
  .action(async () => {
    try {
      await logoutConductor();
      console.log('SDK: logged out');
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

const models = program
  .command('models')
  .description('Conductor (SDK) model catalog');

models
  .command('list')
  .description('List models available to the authenticated conductor account')
  .option('--json', 'Output JSON')
  .action(async (options: { json?: boolean }) => {
    try {
      const catalog = await listConductorModels();
      if (options.json) {
        console.log(formatModelsListJson(catalog));
        return;
      }
      console.log(formatModelsListText(catalog));
      console.error(
        '\n注: 一覧は API カタログです。team 設定で実行時にブロックされる場合があります。',
      );
    } catch (error) {
      console.error(error instanceof Error ? error.message : error);
      process.exit(1);
    }
  });

const profiles = program.command('profiles').description('Team profile catalog');

profiles
  .command('list')
  .description('List team profiles from project, user, bundled, and legacy layers')
  .option('--repo-root <path>', 'Repository root for project and legacy profile discovery', process.cwd())
  .option('--json', 'Output JSON')
  .action(async (options: { repoRoot: string; json?: boolean }) => {
    try {
      const { listTeamProfiles } = await import('@agents-ensemble/core');
      const entries = await listTeamProfiles({ repoRoot: resolve(options.repoRoot) });
      if (options.json) {
        console.log(formatProfilesListJson(entries));
        return;
      }
      console.log(formatProfilesListText(entries));
    } catch (error) {
      console.error(error instanceof Error ? error.message : error);
      process.exit(1);
    }
  });

program.parse();
