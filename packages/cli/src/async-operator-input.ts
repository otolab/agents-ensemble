import * as readline from 'node:readline/promises';
import { stdin as input, stderr, stdout as output } from 'node:process';
import type { OperatorInputBindingApi, OperatorInputContext } from '@agents-ensemble/core';
import { formatIssueReference } from './tui/format-operator-context.js';
import { resolveInitialOperatorMessage } from './operator-message.js';
import { executeRecoveryInboxCommand } from './operator-recovery-command.js';

let activeReprompt: (() => void) | undefined;

export interface AsyncOperatorInputOptions {
  issueUrl?: string;
  initialOperatorMessage?: string;
}

/** open question 追加時に TTY プロンプト直前の案内を更新する。 */
export function notifyOperatorInputReprompt(): void {
  activeReprompt?.();
}

function writeBeforePrompt(context: OperatorInputContext, issueUrl?: string): void {
  if (issueUrl) {
    stderr.write(`\nIssue: ${formatIssueReference(issueUrl, 'url')}\n`);
  }

  const { openQuestions } = context;
  if (openQuestions.length === 0) {
    return;
  }
  stderr.write('\nオペレータの入力が必要です:\n');
  stderr.write('未回答のオペレータ質問:\n');
  for (const question of openQuestions) {
    stderr.write(
      `- ${question.id} [${question.responseType}] ${question.question}\n`,
    );
    if (question.context) {
      stderr.write(`  ${question.context}\n`);
    }
  }
}

/** TTY 向け: 行入力を非ブロッキングで `submit` へ渡す。 */
export function bindAsyncOperatorInput(
  api: OperatorInputBindingApi,
  options: AsyncOperatorInputOptions = {},
): () => void {
  const initialOperatorMessage = resolveInitialOperatorMessage(
    options.initialOperatorMessage,
  );
  if (initialOperatorMessage) {
    if (!handleLocalRecoveryCommand(api, initialOperatorMessage)) {
      api.submit(initialOperatorMessage);
    }
    return () => {};
  }

  if (!input.isTTY) {
    return () => {};
  }

  stderr.write(
    '\nオペレータ入力: 任意のタイミングで入力して Enter。conductor は継続します（/reconnect、/recovery、/close 保存して閉じる、/exit 掃除して終了）。\n',
  );

  const rl = readline.createInterface({ input, output, terminal: true });
  rl.setPrompt('operator> ');

  const showPrompt = () => {
    writeBeforePrompt(api.getContext(), options.issueUrl);
    rl.prompt();
  };

  const onLine = (line: string) => {
    const trimmed = line.trim();
    if (trimmed) {
      if (!handleLocalRecoveryCommand(api, trimmed)) {
        api.submit(trimmed);
      }
    }
    showPrompt();
  };

  rl.on('line', onLine);
  activeReprompt = showPrompt;
  showPrompt();

  return () => {
    if (activeReprompt === showPrompt) {
      activeReprompt = undefined;
    }
    rl.off('line', onLine);
    rl.close();
  };
}

function handleLocalRecoveryCommand(
  api: OperatorInputBindingApi,
  inputText: string,
): boolean {
  const recoveryCommand = executeRecoveryInboxCommand(api, inputText, {
    canDisplaySensitiveContent:
      input.isTTY === true &&
      output.isTTY === true &&
      stderr.isTTY === true,
  });
  if (!recoveryCommand.handled) return false;
  if (recoveryCommand.inspection) {
    stderr.write(
      `\n${recoveryCommand.inspection.title}\n${recoveryCommand.inspection.text}\n\n`,
    );
  }
  return true;
}
