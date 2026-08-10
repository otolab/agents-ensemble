#!/usr/bin/env node

import { resolve } from 'node:path';
import { Command } from 'commander';
import {
  dispatchWorker,
  getConductorAuthStatus,
  listConductorModels,
  loadProfile,
  loginConductor,
  PermissionBroker,
  runIssueSession,
  SessionLogger,
} from '@agents-ensemble/core';
import { bindAsyncOperatorInput } from './async-operator-input.js';
import { formatModelsListJson, formatModelsListText } from './format-models-list.js';
import { formatIssueSessionSummaryJson } from './format-session-summary.js';
import { isOperatorInputInteractive } from './prompt-operator-input.js';
import { promptPermissionDecision } from './prompt-permission.js';
import { parseWorktreeMode } from './parse-worktree-mode.js';
import { createDialogueSink, createHarnessSink } from './session-sinks.js';

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
  .option(
    '--profile <name>',
    'Profile name or path (default: bundled default; name resolves bundled then cwd profiles/<name>/)',
  )
  .option('--model <id>', 'Conductor model id (default: composer-2.5)')
  .option(
    '--max-turns <n>',
    'Maximum conductor turns (default: 5)',
    (value) => Number.parseInt(value, 10),
    5,
  )
  .option(
    '--worktree <mode>',
    'Worker workspace: isolated (default, per-issue worktree) or in-repo (main worktree)',
    'isolated',
  )
  .action(
    async (
      issueUrl: string,
      options: {
        repoRoot: string;
        conductorCwd: string;
        resume?: string;
        profile?: string;
        model?: string;
        maxTurns: number;
        worktree: string;
      },
    ) => {
      try {
        const workerWorktreeMode = parseWorktreeMode(options.worktree);
        if (workerWorktreeMode === 'in_repo') {
          console.error(
            '[worktree] 特別モード: メイン worktree で直接作業します（isolated worktree は作りません）',
          );
        }
        const { profile, profilePath } = await loadProfile({
          profile: options.profile,
          cwd: resolve(options.repoRoot),
        });
        const repoRoot = resolve(options.repoRoot);
        const sessionLogger = new SessionLogger({ issueUrl, repoRoot });
        sessionLogger.subscribe(createHarnessSink());
        const interactive = isOperatorInputInteractive();
        if (interactive) {
          sessionLogger.subscribe(createDialogueSink());
        }
        const result = await runIssueSession({
          issueUrl,
          repoRoot,
          conductorCwd: resolve(options.conductorCwd),
          resumeAgentId: options.resume,
          profile,
          profilePath,
          modelId: options.model,
          maxTurns: options.maxTurns,
          workerWorktreeMode,
          sessionLogger,
          ...(interactive
            ? {
                bindOperatorInput: bindAsyncOperatorInput,
                continueOnConductorError: true,
              }
            : {}),
          onOpenQuestionEnqueued: (question) => {
            console.error(
              `[open question] ${question.id} [${question.responseType}] ${question.question}`,
            );
          },
          onEscalated: (record) => {
            console.error(`[operator answer] ${record.question} → ${record.answer}`);
          },
        });

        console.log(formatIssueSessionSummaryJson(result));

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

const dispatch = program
  .command('dispatch')
  .description('Dispatch a worker without conductor');

dispatch
  .command('worker')
  .description('Dispatch a worker for a GitHub Issue (Stage 1 manual flow)')
  .argument('<issue-url>', 'GitHub Issue URL')
  .option('--name <name>', 'Worker name in the session', 'worker')
  .option('--kind <name>', 'Agent kind for the worker prompt', 'worker')
  .option('--system-prompt <text>', 'Optional agent system prompt override')
  .option(
    '--repo-root <path>',
    'Path to the local git clone to work in',
    process.cwd(),
  )
  .option(
    '--worktree <mode>',
    'Worker workspace: isolated (default) or in-repo (main worktree)',
    'isolated',
  )
  .action(
    async (
      issueUrl: string,
      options: {
        name: string;
        kind: string;
        systemPrompt?: string;
        repoRoot: string;
        worktree: string;
      },
    ) => {
    try {
      const worktreeMode = parseWorktreeMode(options.worktree);
      if (worktreeMode === 'in_repo') {
        console.error(
          '[worktree] 特別モード: メイン worktree で直接作業します（isolated worktree は作りません）',
        );
      }
      const permissionBroker = new PermissionBroker({
        onAsk: promptPermissionDecision,
      });
      const result = await dispatchWorker({
        issueUrl,
        name: options.name,
        kind: options.kind,
        systemPrompt: options.systemPrompt,
        repoRoot: resolve(options.repoRoot),
        worktreeMode,
        sessionState: {
          workers: [{ name: options.name, kind: options.kind }],
          kinds: [options.kind],
        },
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
            kind: result.kind,
            name: result.name,
            stopReason: result.promptResult.stopReason,
            responseText: result.promptResult.responseText,
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
