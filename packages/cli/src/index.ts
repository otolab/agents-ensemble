#!/usr/bin/env node

import { resolve } from 'node:path';
import { Command, Option } from 'commander';
import {
  DEFAULT_DISPATCH_HOLD_REMINDER_MS,
  DEFAULT_PERMISSION_DEADLOCK_STALL_MS,
  listConductorModels,
  resolveIssueUrl,
} from '@agents-ensemble/core';
import { readCliPackageVersion } from './cli-version.js';
import { executeIssueCommand, issueCommandExitCode } from './issue-command.js';
import { formatModelsListJson, formatModelsListNote, formatModelsListText } from './format-models-list.js';
import { isOperatorInputTty } from './prompt-operator-input.js';
import { resolveIssueSummaryFormat } from './resolve-summary-format.js';
import { writeIssueSessionSummary } from './write-issue-session-summary.js';
import { formatProfilesListJson, formatProfilesListText } from './format-profiles-list.js';
import { normalizeInitialOperatorMessage } from './operator-message.js';
import {
  formatSessionListText,
  formatSessionMessagesText,
  formatSessionShowText,
  formatSessionWorkerMessagesText,
  listSavedSessionMessages,
  listSavedSessions,
  readSavedSessionWorkerMessages,
  showSavedSession,
} from './session-command.js';
import {
  runConductorAuthStatus,
  runConductorLogin,
  runConductorLogout,
  resolveConductorCommandContext,
  type ConductorCommandOptions,
} from './conductor-auth-command.js';
import {
  runPiModelsAdd,
  runPiModelsDiff,
  runPiModelsRemote,
  runPiModelsSync,
  type PiModelsSyncResult,
  type PiModelsSyncTarget,
} from './pi-model-catalog-command.js';
import { runOperatorAgent } from '@agents-ensemble/operator-agent';

const program = new Command();

program
  .name('ensemble')
  .description('Issue-based agent orchestration')
  .version(readCliPackageVersion());

program
  .command('operator-agent')
  .description('Chat with an operator agent about repository session state')
  .option('--repo-root <path>', 'Repository root for config and saved sessions', process.cwd())
  .option(
    '--config <path>',
    'Use this file instead of ~/.ensemble/config.yaml; project config still applies',
  )
  .option('--new', 'Start a fresh operator-agent session')
  .action(async (options: { repoRoot: string; config?: string; new: boolean }) => {
    try {
      await runOperatorAgent({
        repoRoot: resolve(options.repoRoot),
        configPath: options.config,
        newSession: options.new,
      });
    } catch (error) {
      console.error(error instanceof Error ? error.message : error);
      process.exit(1);
    }
  });

const session = program
  .command('session')
  .description(
    'Read saved conductor and worker session data without starting an agent',
  );

session
  .command('list')
  .description('List saved sessions for a repository')
  .option(
    '--repo-root <path>',
    'Repository root for saved sessions',
    process.cwd(),
  )
  .option('--issue-url <url>', 'Filter by GitHub Issue URL')
  .option('--json', 'Output JSON')
  .action(
    async (options: {
      repoRoot: string;
      issueUrl?: string;
      json?: boolean;
    }) => {
      try {
        const result = await listSavedSessions({
          repoRoot: options.repoRoot,
          issueUrl: options.issueUrl,
        });
        console.log(
          options.json
            ? JSON.stringify(result, null, 2)
            : formatSessionListText(result),
        );
      } catch (error) {
        console.error(error instanceof Error ? error.message : error);
        process.exit(1);
      }
    },
  );

session
  .command('show')
  .description('Show saved session metadata and related YAML summaries')
  .argument('<conductorAgentId>', 'Conductor session id')
  .option(
    '--repo-root <path>',
    'Repository root for saved sessions',
    process.cwd(),
  )
  .option('--json', 'Output JSON')
  .action(
    async (
      conductorAgentId: string,
      options: { repoRoot: string; json?: boolean },
    ) => {
      try {
        const result = await showSavedSession({
          repoRoot: options.repoRoot,
          conductorAgentId,
        });
        console.log(
          options.json
            ? JSON.stringify(result, null, 2)
            : formatSessionShowText(result),
        );
      } catch (error) {
        console.error(error instanceof Error ? error.message : error);
        process.exit(1);
      }
    },
  );

session
  .command('messages')
  .description(
    'Show raw saved conductor provider history for local debugging (may contain secrets)',
  )
  .argument('<conductorAgentId>', 'Conductor session id')
  .option(
    '--repo-root <path>',
    'Repository root for saved sessions',
    process.cwd(),
  )
  .option(
    '--limit <n>',
    'Number of messages to return (default: 20, maximum: 100)',
    parseSessionLimit,
  )
  .option(
    '--order <order>',
    'Provider order: asc or desc (default: desc)',
    'desc',
  )
  .option('--cursor <providerId>', 'Exclusive provider history cursor')
  .option('--json', 'Output JSON')
  .action(
    async (
      conductorAgentId: string,
      options: {
        repoRoot: string;
        limit?: number;
        order: string;
        cursor?: string;
        json?: boolean;
      },
    ) => {
      try {
        const result = await listSavedSessionMessages({
          repoRoot: options.repoRoot,
          conductorAgentId,
          limit: options.limit,
          order: parseSessionMessageOrder(options.order),
          cursor: options.cursor,
        });
        console.log(
          options.json
            ? JSON.stringify(result, null, 2)
            : formatSessionMessagesText(result),
        );
      } catch (error) {
        console.error(error instanceof Error ? error.message : error);
        process.exit(1);
      }
    },
  );

const sessionWorkers = session
  .command('workers')
  .description('Read saved worker ACP session data');

sessionWorkers
  .command('messages')
  .description(
    'Read saved worker history for supported ACP presets (currently Pi; may contain secrets)',
  )
  .argument('<conductorAgentId>', 'Conductor session id')
  .requiredOption('--worker <name>', 'Worker name from the saved session')
  .option(
    '--repo-root <path>',
    'Repository root for saved sessions',
    process.cwd(),
  )
  .option('--json', 'Output JSON')
  .action(
    async (
      conductorAgentId: string,
      options: {
        worker: string;
        repoRoot: string;
        json?: boolean;
      },
    ) => {
      try {
        const result = await readSavedSessionWorkerMessages({
          repoRoot: options.repoRoot,
          conductorAgentId,
          workerName: options.worker,
        });
        console.log(
          options.json
            ? JSON.stringify(result, null, 2)
            : formatSessionWorkerMessagesText(result),
        );
        if (result.status === 'unsupported') process.exitCode = 2;
        if (result.status === 'unavailable') process.exitCode = 1;
      } catch (error) {
        console.error(error instanceof Error ? error.message : error);
        process.exit(1);
      }
    },
  );

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
    '--config <path>',
    'Use this file instead of ~/.ensemble/config.yaml; project config still applies',
  )
  .option(
    '--conductor-cwd <path>',
    'Workspace for the conductor SDK agent',
    process.cwd(),
  )
  .option('--resume <agentId>', 'Resume a previous conductor agent')
  .option(
    '--continue',
    'Resume the latest session for this issue (uses the saved session state with the newest updatedAt)',
  )
  .option(
    '--profile <name>',
    'Team profile name or path (default: config profile.default, ENSEMBLE_DEFAULT_PROFILE env, else bundled implementer-and-reviewer-v2). Name resolves: project .ensemble/teams/ > ~/.ensemble/teams/ > bundled > legacy profiles/',
  )
  .option('--model <id>', 'Conductor model id (default: config conductor.model, else default)')
  .option(
    '--reasoning <level>',
    'Conductor reasoning / thinking level (default: config conductor.reasoning, else backend default)',
  )
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
    'Exit immediately when the autonomous loop completes (TTY default: wait for /close or /exit)',
  )
  .option(
    '--worktree <mode>',
    'Worker workspace: isolated (default via config) or in-repo (main worktree)',
  )
  .option(
    '--default-acp-cli <preset>',
    'Default ACP CLI preset applied to all workers (cursor | claude | codex | pi)',
  )
  .option(
    '--default-acp-command <cmd>',
    'Default custom ACP command for all workers (overrides --default-acp-cli)',
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
    '--dispatch-hold-reminder-ms <n>',
    `Dispatch hold operator reminder interval in milliseconds (default: ${DEFAULT_DISPATCH_HOLD_REMINDER_MS})`,
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
        config?: string;
        resume?: string;
        continue?: boolean;
        profile?: string;
        model?: string;
        reasoning?: string;
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
        dispatchHoldReminderMs?: number;
        summaryFormat?: string;
        includeFullResponseText?: boolean;
      },
    ) => {
      try {
        const repoRoot = resolve(options.repoRoot);
        const issueUrl = await resolveIssueUrl(issueRef, repoRoot);
        const result = await executeIssueCommand(issueUrl, {
          ...options,
          configPath: options.config,
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

        const exitCode = issueCommandExitCode(result);
        if (exitCode !== 0) {
          process.exit(exitCode);
        }
      } catch (error) {
        console.error(error instanceof Error ? error.message : error);
        process.exit(1);
      }
    },
  );

function addConductorCommandOptions(command: Command, catalog = false): Command {
  return command
    .option(
      '--repo-root <path>',
      'Repository root used for config, profile, and Pi project resources',
      process.cwd(),
    )
    .option('--profile <name>', 'Team profile used to resolve conductor.backend')
    .option(
      '--provider <id>',
      catalog ? 'Required: configured Pi provider ID' : 'Pi provider (default: settings.json defaultProvider)',
    )
    .option(
      '--model-id <id>',
      catalog ? 'Pi model id (does not select the catalog provider)' : 'Pi model id used to infer the provider',
    );
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
      console.error(formatModelsListNote(context.auth.backend ?? 'cursor'));
    } catch (error) {
      console.error(error instanceof Error ? error.message : error);
      process.exit(1);
    }
  });

addConductorCommandOptions(models.command('remote'), true)
  .description('List IDs from a configured Pi provider remote catalog')
  .option('--json', 'Output JSON')
  .action(async (options: ConductorCommandOptions & { json?: boolean }) => {
    try {
      const result = await runPiModelsRemote(options);
      console.log(options.json ? JSON.stringify(result, null, 2) : result.ids.join('\n'));
    } catch (error) {
      console.error(error instanceof Error ? error.message : error);
      process.exit(1);
    }
  });

addConductorCommandOptions(models.command('diff'), true)
  .description('Compare remote and configured Pi model IDs')
  .option('--json', 'Output JSON')
  .action(async (options: ConductorCommandOptions & { json?: boolean }) => {
    try {
      const result = await runPiModelsDiff(options);
      if (options.json) {
        console.log(JSON.stringify(result, null, 2));
        return;
      }
      const lines = [`Pi provider: ${result.provider}`];
      appendModelGroup(lines, 'API only', result.apiOnly);
      appendModelGroup(lines, 'JSON only', result.jsonOnly);
      appendModelGroup(lines, 'Both', result.shared);
      console.log(lines.join('\n'));
    } catch (error) {
      console.error(error instanceof Error ? error.message : error);
      process.exit(1);
    }
  });

addConductorCommandOptions(models.command('add'), true)
  .description('Add explicitly selected remote Pi model IDs to models.json')
  .argument('<id...>', 'Remote model IDs to add')
  .addOption(
    new Option('--target <layer>', 'models.json layer to update (default: user)')
      .choices(['project', 'user']),
  )
  .option(
    '--refresh-metadata',
    'Refresh API-supplied metadata for existing models',
  )
  .option('--json', 'Output JSON')
  .action(
    async (
      ids: string[],
      options: ConductorCommandOptions & {
        target?: PiModelsSyncTarget;
        refreshMetadata?: boolean;
        json?: boolean;
      },
    ) => {
      try {
        const result = await runPiModelsAdd(options, ids);
        for (const warning of result.metadataWarnings ?? []) {
          console.error(`Warning: ${warning}`);
        }
        if (options.json) {
          console.log(JSON.stringify({
            provider: result.provider,
            added: result.added,
            skipped: result.skipped,
            ...(result.refreshed.length > 0
              ? { refreshed: result.refreshed }
              : {}),
            ...(result.metadataWarnings
              ? { metadataWarnings: result.metadataWarnings }
              : {}),
            ...(result.targetPath ? { targetPath: result.targetPath } : {}),
          }, null, 2));
          return;
        }
        if (result.added.length > 0) {
          console.log(`Added ${result.added.join(', ')} to ${result.targetPath}`);
        }
        if (result.refreshed.length > 0) {
          console.log(
            `Refreshed model metadata for ${result.refreshed.join(', ')} in ${result.targetPath}`,
          );
        }
        if (result.skipped.length > 0) {
          console.log(`Already present; preserved: ${result.skipped.join(', ')}`);
        }
      } catch (error) {
        console.error(error instanceof Error ? error.message : error);
        process.exit(1);
      }
    },
  );

addConductorCommandOptions(models.command('sync'), true)
  .description('Deprecated: use models diff and models add instead')
  .addOption(
    new Option('--target <layer>', 'models.json layer to update when adding IDs (default: user)')
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
      console.error('Warning: models sync is deprecated; use models diff and models add instead.');
      try {
        const result = await runPiModelsSync(options);
        for (const warning of result.metadataWarnings ?? []) {
          console.error(`Warning: ${warning}`);
        }
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
      ...(result.metadataWarnings
        ? { metadataWarnings: result.metadataWarnings }
        : {}),
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

function parseSessionLimit(value: string): number {
  const limit = Number(value);
  if (!Number.isSafeInteger(limit)) {
    throw new Error('limit must be an integer.');
  }
  return limit;
}

function parseSessionMessageOrder(value: string): 'asc' | 'desc' {
  if (value === 'asc' || value === 'desc') return value;
  throw new Error('order must be asc or desc.');
}

program.parse();
