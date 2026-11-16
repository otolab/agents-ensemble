#!/usr/bin/env node

import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Command, CommanderError, Option } from 'commander';
import {
  DEFAULT_DISPATCH_HOLD_REMINDER_MS,
  DEFAULT_PERMISSION_DEADLOCK_STALL_MS,
  listConductorModels,
  resolveIssueUrl,
  escapeTerminalControlCharacters,
} from '@agents-ensemble/core';
import {
  exportSessionBundle,
  type ExportSessionBundleResult,
} from '@agents-ensemble/core/operator-runtime';
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
  formatSessionTimelineText,
  readSavedSessionTimeline,
} from './session-timeline.js';
import {
  runConductorAuthStatus,
  runConductorClearCommand,
  runConductorLogin,
  runConductorSetCommand,
  runConductorLogout,
  resolveConductorCommandContext,
  type ConductorCommandOptions,
} from './conductor-auth-command.js';
import { runSetupCommand } from './setup-command.js';
import { runDoctorCommand } from './doctor-command.js';
import { runDoctorCheckCommand } from './doctor-check-command.js';
import {
  runPiModelsAdd,
  runPiModelsDiff,
  runPiModelsRemote,
  runPiModelsSync,
  type PiModelsSyncResult,
  type PiModelsSyncTarget,
} from './pi-model-catalog-command.js';
import { runOperatorAgent } from '@agents-ensemble/operator-agent';
import { runSecretExec, runSecretPush } from './secret-command.js';

const program = new Command();
const cliEntrypoint = fileURLToPath(import.meta.url);

program
  .name('ensemble')
  .description('Issue-based agent orchestration')
  .version(readCliPackageVersion());

const secret = program
  .command('secret')
  .description('One-time operator-approved secret input for a waiting worker command');

secret
  .command('exec')
  .description('Wait for one secret value, then run a command with it in one env variable')
  .requiredOption('--label <label>', 'Operator-facing name of the secret target')
  .requiredOption('--env <name>', 'Environment variable name for the one-time value')
  .argument('<command>', 'Target executable')
  .argument('[args...]', 'Target argv; put -- before target options')
  .action(
    async (
      command: string,
      args: string[],
      options: { label: string; env: string },
    ) => {
      process.exitCode = await runSecretExec({
        label: options.label,
        envName: options.env,
        command,
        args: args ?? [],
      });
    },
  );

secret
  .command('push')
  .description('Approve a displayed one-time request and submit its value from stdin')
  .argument('<socketPath>', 'Live session secret IPC socket')
  .argument('<requestId>', 'One-time request capability shown by the harness')
  .action(async (socketPath: string, requestId: string) => {
    process.exitCode = await runSecretPush(socketPath, requestId);
  });

program
  .command('operator-agent')
  .description('Chat with an operator agent using a user-scoped operator profile')
  .option('--profile <name>', 'Select a profile from ~/.ensemble/operator-agents.config.yaml')
  .option(
    '--repo-filter <owner/repo|owner/*>',
    'Limit Issue sessions to matching repositories (repeatable)',
    (value: string, previous: string[]) => [...previous, value],
    [],
  )
  .addOption(
    new Option('--resume <operatorAgentId>', 'Resume a specific saved conversation')
      .conflicts('new'),
  )
  .addOption(
    new Option('--new', 'Start a new conversation and keep all existing conversations')
      .conflicts('resume'),
  )
  .action(async (options: {
    profile?: string;
    repoFilter: string[];
    resume?: string;
    new: boolean;
  }) => {
    try {
      await runOperatorAgent({
        profile: options.profile,
        repoFilters: options.repoFilter,
        resumeId: options.resume,
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
  .command('export')
  .description(
    'Export a raw saved session bundle for offline analysis (may contain secrets)',
  )
  .argument('<conductorAgentId>', 'Conductor session id')
  .requiredOption('--output <dir>', 'Create a new bundle directory at this path')
  .option(
    '--repo-root <path>',
    'Current clone for local fallback paths; session lookup uses an explicit GitHub scope',
    process.cwd(),
  )
  .option('--github-repo <owner/repo>', 'Repository scope for the saved session')
  .option('--issue-url <url>', 'Issue scope for the saved session')
  .option(
    '--include-tool-calls',
    'Include optional tool-call snapshot history when available',
  )
  .option('--summary <path>', 'Copy an existing SessionSummary JSON file')
  .option('--harness-log <path>', 'Copy a captured harness stderr log')
  .option('--json', 'Output the bundle result and manifest as JSON')
  .action(
    async (
      conductorAgentId: string,
      options: {
        output: string;
        repoRoot: string;
        githubRepo?: string;
        issueUrl?: string;
        includeToolCalls?: boolean;
        summary?: string;
        harnessLog?: string;
        json?: boolean;
      },
    ) => {
      try {
        const result = await exportSessionBundle({
          repoRoot: options.repoRoot,
          conductorAgentId,
          githubRepo: options.githubRepo,
          issueUrl: options.issueUrl,
          outputDirectory: options.output,
          ensembleVersion: readCliPackageVersion(),
          cliVersion: readCliPackageVersion(),
          includeToolCalls: options.includeToolCalls,
          summaryPath: options.summary,
          harnessLogPath: options.harnessLog,
        });
        console.log(
          options.json
            ? JSON.stringify(result, null, 2)
            : formatSessionExportText(result),
        );
      } catch (error) {
        console.error(error instanceof Error ? error.message : error);
        process.exit(1);
      }
    },
  );

session
  .command('list')
  .description('List local saved sessions across all repositories by default')
  .option(
    '--repo-root <path>',
    'Current clone for local fallback paths; it does not limit slug lookup',
    process.cwd(),
  )
  .option('--github-repo <owner/repo>', 'Filter by GitHub repository slug')
  .option('--issue-url <url>', 'Filter by GitHub Issue URL')
  .option('--conductor-agent-id <id>', 'Filter by conductor session id')
  .option(
    '--limit <n>',
    'Page size (1–500); without a limit, return every matching local session',
    parseSessionListLimit,
  )
  .option('--cursor <cursor>', 'Continue from the previous page')
  .option('--json', 'Output JSON')
  .action(
    async (options: {
      repoRoot: string;
      githubRepo?: string;
      issueUrl?: string;
      conductorAgentId?: string;
      limit?: number;
      cursor?: string;
      json?: boolean;
    }) => {
      try {
        const result = await listSavedSessions({
          repoRoot: options.repoRoot,
          githubRepo: options.githubRepo,
          issueUrl: options.issueUrl,
          conductorAgentId: options.conductorAgentId,
          limit: options.limit,
          cursor: options.cursor,
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
    'Current clone for local fallback paths',
    process.cwd(),
  )
  .option('--github-repo <owner/repo>', 'Repository scope for the saved session')
  .option('--issue-url <url>', 'Issue scope for the saved session')
  .option('--json', 'Output JSON')
  .action(
    async (
      conductorAgentId: string,
      options: {
        repoRoot: string;
        githubRepo?: string;
        issueUrl?: string;
        json?: boolean;
      },
    ) => {
      try {
        const result = await showSavedSession({
          repoRoot: options.repoRoot,
          conductorAgentId,
          githubRepo: options.githubRepo,
          issueUrl: options.issueUrl,
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
    'Current clone for local fallback paths',
    process.cwd(),
  )
  .option('--github-repo <owner/repo>', 'Repository scope for the saved session')
  .option('--issue-url <url>', 'Issue scope for the saved session')
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
        githubRepo?: string;
        issueUrl?: string;
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
          githubRepo: options.githubRepo,
          issueUrl: options.issueUrl,
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
    'Read saved worker history for supported ACP presets (currently Pi and Codex; may contain secrets)',
  )
  .argument('<conductorAgentId>', 'Conductor session id')
  .requiredOption('--worker <name>', 'Worker name from the saved session')
  .option(
    '--repo-root <path>',
    'Current clone for local fallback paths',
    process.cwd(),
  )
  .option('--github-repo <owner/repo>', 'Repository scope for the saved session')
  .option('--issue-url <url>', 'Issue scope for the saved session')
  .option('--json', 'Output JSON')
  .action(
    async (
      conductorAgentId: string,
      options: {
        worker: string;
        repoRoot: string;
        githubRepo?: string;
        issueUrl?: string;
        json?: boolean;
      },
    ) => {
      try {
        const result = await readSavedSessionWorkerMessages({
          repoRoot: options.repoRoot,
          conductorAgentId,
          workerName: options.worker,
          githubRepo: options.githubRepo,
          issueUrl: options.issueUrl,
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

session
  .command('timeline')
  .description(
    'Correlate saved provider history with an optional SessionSummary and captured harness log (may contain secrets)',
  )
  .argument('<conductorAgentId>', 'Conductor session id')
  .option(
    '--repo-root <path>',
    'Current clone for local fallback paths',
    process.cwd(),
  )
  .option('--github-repo <owner/repo>', 'Repository scope for the saved session')
  .option('--issue-url <url>', 'Issue scope for the saved session')
  .option(
    '--summary <path>',
    'Read an existing SessionSummary JSON file',
  )
  .option(
    '--harness-log <path>',
    'Read a captured stderr log for conductor send and reconnect rows',
  )
  .option('--json', 'Output JSON')
  .action(
    async (
      conductorAgentId: string,
      options: {
        repoRoot: string;
        githubRepo?: string;
        issueUrl?: string;
        summary?: string;
        harnessLog?: string;
        json?: boolean;
      },
    ) => {
      try {
        const result = await readSavedSessionTimeline({
          repoRoot: options.repoRoot,
          conductorAgentId,
          githubRepo: options.githubRepo,
          issueUrl: options.issueUrl,
          summaryPath: options.summary,
          harnessLogPath: options.harnessLog,
        });
        console.log(
          options.json
            ? JSON.stringify(result, null, 2)
            : formatSessionTimelineText(result),
        );
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
          secretCliEntrypoint: cliEntrypoint,
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

function addConductorCommandOptions(
  command: Command,
  catalog = false,
  providerRequired = false,
): Command {
  const configured = command
    .option(
      '--repo-root <path>',
      'Repository root used for config, profile, and Pi project resources',
      process.cwd(),
    )
    .option('--profile <name>', 'Team profile used to resolve conductor.backend');
  const providerDescription = catalog
    ? 'Required: configured Pi provider ID'
    : 'Pi provider (default: settings.json defaultProvider)';
  if (providerRequired) {
    configured.requiredOption('--provider <id>', providerDescription);
  } else {
    configured.option('--provider <id>', providerDescription);
  }
  return configured
    .option(
      '--model-id <id>',
      catalog ? 'Pi model id (does not select the catalog provider)' : 'Pi model id used to infer the provider',
    );
}

program
  .command('setup')
  .description('Set up the conductor backend and log in')
  .option(
    '--repo-root <path>',
    'Repository root used to resolve project configuration',
    process.cwd(),
  )
  .action(async (options: { repoRoot: string }) => {
    try {
      await runSetupCommand({ repoRoot: resolve(options.repoRoot) });
    } catch (error) {
      console.error(error instanceof Error ? error.message : error);
      process.exit(1);
    }
  });

const doctor = program
  .command('doctor')
  .description(
    'Configure allowlisted settings or run non-interactive diagnostics',
  )
  .option(
    '--repo-root <path>',
    'Repository root used to resolve project configuration',
    process.cwd(),
  )
  .option(
    '--project',
    'Allow approved changes to be written to this project config',
  )
  .action(async (options: { repoRoot: string; project?: boolean }) => {
    try {
      await runDoctorCommand({
        repoRoot: resolve(options.repoRoot),
        project: options.project,
      });
    } catch (error) {
      console.error(error instanceof Error ? error.message : error);
      process.exitCode = 1;
    }
  });

const doctorCheck = doctor
  .command('check')
  .description(
    'Check local conductor, worker, and config prerequisites without changing settings',
  )
  .argument(
    '[request...]',
    'Natural-language request; Pi only (one turn); Cursor is unsupported (exit 2)',
  )
  .option('--json', 'Output the structured diagnostic report as JSON')
  .option(
    '--repo-root <path>',
    'Repository root used to resolve project configuration',
    process.cwd(),
  )
  .action(
    async (
      request: string[],
      options: { json?: boolean; repoRoot: string },
    ) => {
      try {
        const report = await runDoctorCheckCommand({
          request,
          json: options.json,
          repoRoot: resolve(options.repoRoot),
        });
        process.exitCode = report.exitCode;
      } catch {
        console.error('Doctor check を完了できませんでした。');
        process.exitCode = 2;
      }
    },
  );

doctorCheck.exitOverride();

const auth = program.command('auth').description('Conductor authentication');

addConductorCommandOptions(auth.command('login'))
  .description(
    'Log in to the configured conductor backend (Cursor browser login or Pi provider login)',
  )
  .option(
    '--api-key-prompt',
    'Select Pi API-key login and enter the key at a hidden TTY prompt',
  )
  .option(
    '--api-key-stdin',
    'Read a Pi API key from non-TTY standard input and store it in the user auth.json',
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

addConductorCommandOptions(auth.command('set-command'), false, true)
  .description('Register a Pi !command credential in settings.json')
  .argument('<command>', 'Pi API-key command value beginning with !')
  .addOption(
    new Option('--target <layer>', 'Pi settings layer to update (default: user)')
      .choices(['user', 'project'])
      .default('user'),
  )
  .action(
    async (
      command: string,
      options: ConductorCommandOptions & {
        target: 'user' | 'project';
      },
    ) => {
      try {
        console.error(
          [
            'Warning: Pi will run this command with the conductor process user and environment when resolving provider credentials.',
            'Review and trust the command before using it. Registration and auth status do not execute it.',
            ...(options.target === 'project'
              ? ['Project Pi settings may be committed; verify the repository is trusted and the resource is ignored as intended.']
              : []),
          ].join('\n'),
        );
        const result = await runConductorSetCommand({
          ...options,
          command,
        });
        console.log(
          `Pi: command credential configured for ${result.provider} (${result.target}); settings: ${escapeTerminalControlCharacters(result.settingsPath)}`,
        );
      } catch (error) {
        console.error(error instanceof Error ? error.message : error);
        process.exit(1);
      }
    },
  );

addConductorCommandOptions(auth.command('clear-command'), false, true)
  .description('Remove a Pi !command credential from settings.json')
  .addOption(
    new Option('--target <layer>', 'Pi settings layer to update (default: user)')
      .choices(['user', 'project'])
      .default('user'),
  )
  .action(
    async (
      options: ConductorCommandOptions & {
        target: 'user' | 'project';
      },
    ) => {
      try {
        const result = await runConductorClearCommand(options);
        if (result.cleared) {
          console.log(
            `Pi: command credential cleared for ${result.provider} (${result.target}); settings: ${escapeTerminalControlCharacters(result.settingsPath)}`,
          );
        } else {
          console.log(
            `Pi: no command credential for ${result.provider} in ${result.target} settings; file left unchanged (${escapeTerminalControlCharacters(result.settingsPath)})`,
          );
        }
      } catch (error) {
        console.error(error instanceof Error ? error.message : error);
        process.exit(1);
      }
    },
  );

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
          const mode = provider.mode ? `; mode=${provider.mode}` : '';
          const scope = provider.scope ? `; scope=${provider.scope}` : '';
          const configurationPath = provider.configurationPath
            ? `; config=${escapeTerminalControlCharacters(provider.configurationPath)}`
            : '';
          const commandConfiguration = provider.commandConfiguration
            ? `; command-config=${provider.commandConfiguration.source}; command-scope=${provider.commandConfiguration.scope}; command-path=${escapeTerminalControlCharacters(provider.commandConfiguration.path)}; command-effective=${provider.commandConfiguration.effective}`
            : '';
          const label = provider.label ? `; label=${provider.label}` : '';
          console.log(
            `Pi: ${provider.provider}: ${state}${source}${mode}${scope}${configurationPath}${commandConfiguration}${label}`,
          );
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

function parseSessionListLimit(value: string): number {
  const limit = Number(value);
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 500) {
    throw new Error('limit must be an integer between 1 and 500.');
  }
  return limit;
}

function parseSessionMessageOrder(value: string): 'asc' | 'desc' {
  if (value === 'asc' || value === 'desc') return value;
  throw new Error('order must be asc or desc.');
}

function formatSessionExportText(
  result: ExportSessionBundleResult,
): string {
  return [
    `出力先: ${result.outputDirectory}`,
    `manifest: ${result.manifestPath}`,
    `収録ファイル: ${result.fileCount}`,
    `状態: ${result.status === 'complete' ? '完了' : '一部 source を取得できませんでした'}`,
    ...(result.warnings.length > 0
      ? ['警告:', ...result.warnings.map((warning) => `  - ${warning}`)]
      : []),
  ].join('\n');
}

try {
  program.parse();
} catch (error) {
  if (!(error instanceof CommanderError)) throw error;
  if (error.code === 'commander.helpDisplayed') {
    process.exitCode = 0;
  } else {
    if (error.message) console.error(error.message);
    process.exitCode = 2;
  }
}
