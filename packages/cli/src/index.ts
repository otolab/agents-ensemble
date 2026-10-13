#!/usr/bin/env node

import { resolve } from 'node:path';
import { Command, Option } from 'commander';
import {
  DEFAULT_PERMISSION_DEADLOCK_STALL_MS,
  listConductorModels,
  resolveIssueUrl,
} from '@agents-ensemble/core';
import { readCliPackageVersion } from './cli-version.js';
import { executeIssueCommand } from './issue-command.js';
import { formatModelsListJson, formatModelsListText } from './format-models-list.js';
import { isOperatorInputTty } from './prompt-operator-input.js';
import { resolveIssueSummaryFormat } from './resolve-summary-format.js';
import { writeIssueSessionSummary } from './write-issue-session-summary.js';
import { formatProfilesListJson, formatProfilesListText } from './format-profiles-list.js';
import { normalizeInitialOperatorMessage } from './operator-message.js';
import {
  runConductorAuthStatus,
  runConductorLogin,
  runConductorLogout,
  resolveConductorCommandContext,
  type ConductorCommandOptions,
} from './conductor-auth-command.js';
import {
  runPiModelsSync,
  type PiModelsSyncResult,
  type PiModelsSyncTarget,
} from './pi-model-catalog-command.js';

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
  .argument('[message...]', 'Initial operator message words')
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
    'Team profile name or path (default: config profile.default, ENSEMBLE_DEFAULT_PROFILE env, else bundled implementer-and-reviewer). Name resolves: project .ensemble/teams/ > ~/.ensemble/teams/ > bundled > legacy profiles/',
  )
  .option('--model <id>', 'Conductor model id (default: config conductor.model, else default)')
  .option(
    '--verbose',
    'Show detailed harness telemetry (default: config conductor.verbose or false)',
  )
  .option(
    '--max-turns <n>',
    'Maximum conductor autonomous turns (0 = unlimited; default: unlimited on TTY or with an initial operator message, 5 otherwise)',
    (value) => Number.parseInt(value, 10),
  )
  .option('--no-max-turns', 'Disable autonomous turn limit')
  .option(
    '--no-wait',
    'Exit immediately when the autonomous loop completes (TTY default: wait for /exit)',
  )
  .option(
    '--worktree <mode>',
    'Worker workspace: isolated (default via config) or in-repo (main worktree)',
  )
  .option(
    '--default-acp-cli <preset>',
    'Default ACP CLI preset for workers without profile acp (cursor | claude | codex | pi)',
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
    'Debounce interval for GitHub update notifications (default: config github.monitor.debounceMs, else 30000)',
    (value) => Number.parseInt(value, 10),
  )
  .option(
    '--permission-deadlock-stall-ms <n>',
    `Permission deadlock warning threshold in milliseconds (default: ${DEFAULT_PERMISSION_DEADLOCK_STALL_MS})`,
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
      messageParts: string[],
      options: {
        repoRoot: string;
        conductorCwd: string;
        resume?: string;
        continue?: boolean;
        profile?: string;
        model?: string;
        verbose?: boolean;
        maxTurns?: number;
        noMaxTurns?: boolean;
        noWait?: boolean;
        worktree: string;
        defaultAcpCli?: string;
        defaultAcpCommand?: string;
        defaultAcpArg?: string[];
        githubMonitor?: boolean;
        githubMonitorDebounceMs?: number;
        permissionDeadlockStallMs?: number;
        summaryFormat?: string;
        includeFullResponseText?: boolean;
      },
    ) => {
      try {
        const repoRoot = resolve(options.repoRoot);
        const issueUrl = await resolveIssueUrl(issueRef, repoRoot);
        const result = await executeIssueCommand(issueUrl, {
          ...options,
          initialOperatorMessage: normalizeInitialOperatorMessage(messageParts),
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

function addConductorCommandOptions(command: Command): Command {
  return command
    .option(
      '--repo-root <path>',
      'Repository root used for config, profile, and Pi project resources',
      process.cwd(),
    )
    .option('--profile <name>', 'Team profile used to resolve conductor.backend')
    .option('--provider <id>', 'Pi provider (default: settings.json defaultProvider)')
    .option('--model-id <id>', 'Pi model id used to infer the provider');
}

const auth = program.command('auth').description('Conductor authentication');

addConductorCommandOptions(auth.command('login'))
  .description(
    'Log in to the configured conductor backend (Cursor browser login or Pi provider login)',
  )
  .action(async (options: ConductorCommandOptions) => {
    try {
      const result = await runConductorLogin(options);
      if ('method' in result) {
        console.log(
          `Pi: logged in provider ${result.provider} (${result.method}); stored in ${result.authPath}`,
        );
        return;
      }
      const who = result.email ?? 'unknown';
      console.log(`Logged in as ${who}`);
      console.log(`API key expires: ${new Date(result.apiKeyExpiresAtMs).toISOString()}`);
    } catch (error) {
      console.error(error instanceof Error ? error.message : error);
      process.exit(1);
    }
  });

addConductorCommandOptions(auth.command('logout'))
  .description('Clear stored credentials for the configured conductor backend')
  .action(async (options: ConductorCommandOptions) => {
    try {
      const result = await runConductorLogout(options);
      if (result && 'backend' in result && result.backend === 'pi') {
        console.log(`Pi: provider ${result.provider} logged out`);
        return;
      }
      console.log('SDK: logged out');
    } catch (error) {
      console.error(error instanceof Error ? error.message : error);
      process.exit(1);
    }
  });

addConductorCommandOptions(auth.command('status'))
  .description('Show non-secret authentication status for the configured backend')
  .action(async (options: ConductorCommandOptions) => {
    try {
      const status = await runConductorAuthStatus(options);
      if ('providers' in status) {
        console.log(`Pi auth file: ${status.authPath}`);
        if (status.providers.length === 0) {
          console.log('Pi: no provider credentials configured');
        }
        for (const provider of status.providers) {
          const state = provider.configured ? 'configured' : 'not configured';
          const source = provider.source ? `; source=${provider.source}` : '';
          const label = provider.label ? `; label=${provider.label}` : '';
          console.log(`Pi: ${provider.provider}: ${state}${source}${label}`);
        }
        return;
      }

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

const models = program.command('models').description('Conductor model catalog');

addConductorCommandOptions(models.command('list'))
  .description('List models available to the authenticated conductor backend')
  .option('--json', 'Output JSON')
  .action(async (options: ConductorCommandOptions & { json?: boolean }) => {
    try {
      const context = await resolveConductorCommandContext(options);
      const catalog = await listConductorModels({
        ...context.auth,
        ...(options.provider ? { provider: options.provider } : {}),
        ...(options.modelId ? { modelId: options.modelId } : {}),
      });
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

addConductorCommandOptions(models.command('sync'))
  .description('Compare a configured Pi provider catalog and add selected models')
  .addOption(
    new Option('--target <layer>', 'models.json layer to update when adding IDs')
      .choices(['project', 'user']),
  )
  .option(
    '--add <id>',
    'Add an API model ID to the selected models.json (repeatable)',
    (id: string, previous: string[] = []) => [...previous, id],
    [],
  )
  .option('--json', 'Output JSON')
  .action(
    async (
      options: ConductorCommandOptions & {
        target?: PiModelsSyncTarget;
        add?: string[];
        json?: boolean;
      },
    ) => {
      try {
        const result = await runPiModelsSync(options);
        if (options.json) {
          console.log(formatPiModelsSyncJson(result));
          return;
        }
        console.log(formatPiModelsSyncText(result));
      } catch (error) {
        console.error(error instanceof Error ? error.message : error);
        process.exit(1);
      }
    },
  );

function formatPiModelsSyncText(result: PiModelsSyncResult): string {
  const lines = [`Pi provider: ${result.provider}`];
  appendModelGroup(
    lines,
    'API only',
    result.apiOnly.map((model) => model.id),
  );
  appendModelGroup(lines, 'JSON only', result.jsonOnly);
  appendModelGroup(lines, 'Both', result.shared);
  if (result.added.length > 0) {
    lines.push(`Added to ${result.targetPath}:`);
    lines.push(...result.added.map((id) => `  ${id}`));
  }
  if (result.skipped.length > 0) {
    lines.push('Already present; preserved:');
    lines.push(...result.skipped.map((id) => `  ${id}`));
  }
  return lines.join('\n');
}

function appendModelGroup(lines: string[], label: string, ids: string[]): void {
  lines.push(`${label} (${ids.length}):`);
  lines.push(...(ids.length > 0 ? ids.map((id) => `  ${id}`) : ['  （なし）']));
}

function formatPiModelsSyncJson(result: PiModelsSyncResult): string {
  return JSON.stringify(
    {
      provider: result.provider,
      apiOnly: result.apiOnly,
      jsonOnly: result.jsonOnly,
      shared: result.shared,
      added: result.added,
      skipped: result.skipped,
      ...(result.targetPath ? { targetPath: result.targetPath } : {}),
    },
    null,
    2,
  );
}

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
