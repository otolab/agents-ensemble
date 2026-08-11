import { resolve } from 'node:path';
import {
  loadProfile,
  runIssueSession,
  SessionLogger,
  type ConductorSessionResult,
} from '@agents-ensemble/core';
import { bindAsyncOperatorInput, notifyOperatorInputReprompt } from './async-operator-input.js';
import { isOperatorInputInteractive } from './prompt-operator-input.js';
import { parseWorktreeMode } from './parse-worktree-mode.js';
import { resolveCliMaxTurns } from './resolve-cli-max-turns.js';
import { createDialogueSink, createHarnessSink } from './session-sinks.js';

export interface IssueCommandOptions {
  repoRoot: string;
  conductorCwd: string;
  resume?: string;
  profile?: string;
  model?: string;
  maxTurns?: number;
  noMaxTurns?: boolean;
  noWait?: boolean;
  worktree: string;
}

export interface IssueCommandDeps {
  isOperatorInputInteractive?: typeof isOperatorInputInteractive;
  runIssueSession?: typeof runIssueSession;
  loadProfile?: typeof loadProfile;
  SessionLogger?: typeof SessionLogger;
}

/** `ensemble issue` の CLI オプションから `runIssueSession` に渡す `maxTurns` を決定する。 */
export function resolveIssueSessionMaxTurns(
  options: Pick<IssueCommandOptions, 'maxTurns' | 'noMaxTurns'>,
  interactive: boolean,
): number {
  return resolveCliMaxTurns({
    interactive,
    noMaxTurns: options.noMaxTurns,
    maxTurns: options.maxTurns,
  });
}

export async function executeIssueCommand(
  issueUrl: string,
  options: IssueCommandOptions,
  deps: IssueCommandDeps = {},
): Promise<ConductorSessionResult> {
  const isInteractive =
    deps.isOperatorInputInteractive ?? isOperatorInputInteractive;
  const runSession = deps.runIssueSession ?? runIssueSession;
  const loadProfileFn = deps.loadProfile ?? loadProfile;
  const SessionLoggerCtor = deps.SessionLogger ?? SessionLogger;

  const workerWorktreeMode = parseWorktreeMode(options.worktree);
  if (workerWorktreeMode === 'in_repo') {
    console.error(
      '[worktree] 特別モード: メイン worktree で直接作業します（isolated worktree は作りません）',
    );
  }

  const { profile, profilePath } = await loadProfileFn({
    profile: options.profile,
    cwd: resolve(options.repoRoot),
  });
  const repoRoot = resolve(options.repoRoot);
  const sessionLogger = new SessionLoggerCtor({ issueUrl, repoRoot });
  sessionLogger.subscribe(createHarnessSink());

  const interactive = isInteractive();
  const maxTurns = resolveIssueSessionMaxTurns(options, interactive);

  if (interactive) {
    sessionLogger.subscribe(createDialogueSink());
  }

  return runSession({
    issueUrl,
    repoRoot,
    conductorCwd: resolve(options.conductorCwd),
    resumeAgentId: options.resume,
    profile,
    profilePath,
    modelId: options.model,
    maxTurns,
    workerWorktreeMode,
    sessionLogger,
    ...(interactive
      ? {
          bindOperatorInput: bindAsyncOperatorInput,
          continueOnConductorError: true,
          waitForOperatorExit: !options.noWait,
          onPostLoopWait: () => {
            console.error(
              '\n自律作業が一段落しました。追加の指示を入力するか、/exit で終了してください。\n',
            );
          },
        }
      : {}),
    onOpenQuestionEnqueued: (question) => {
      console.error(
        `[open question] ${question.id} [${question.responseType}] ${question.question}`,
      );
      notifyOperatorInputReprompt();
    },
    onEscalated: (record) => {
      console.error(`[operator answer] ${record.question} → ${record.answer}`);
    },
  });
}
