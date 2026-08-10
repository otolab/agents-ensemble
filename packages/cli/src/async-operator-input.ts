import * as readline from 'node:readline/promises';
import { stdin as input, stderr, stdout as output } from 'node:process';
import type { OperatorInputBindingApi, OperatorInputContext } from '@agents-ensemble/core';

const OPERATOR_MESSAGE_ENV = 'ENSEMBLE_OPERATOR_MESSAGE';

let activeReprompt: (() => void) | undefined;

/** open question 追加時に TTY プロンプト直前の案内を更新する。 */
export function notifyOperatorInputReprompt(): void {
  activeReprompt?.();
}

function writeBeforePrompt(context: OperatorInputContext): void {
  const { openQuestions } = context;
  if (openQuestions.length === 0) {
    return;
  }
  stderr.write('\nオペレータの入力が必要です（@inq:<id> <回答>）:\n');
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
export function bindAsyncOperatorInput(api: OperatorInputBindingApi): () => void {
  const fromEnv = process.env[OPERATOR_MESSAGE_ENV]?.trim();
  if (fromEnv) {
    api.submit(fromEnv);
    return () => {};
  }

  if (!input.isTTY) {
    return () => {};
  }

  stderr.write(
    '\nオペレータ入力: 任意のタイミングで入力して Enter。conductor は継続します。\n',
  );

  const rl = readline.createInterface({ input, output, terminal: true });
  rl.setPrompt('operator> ');

  const showPrompt = () => {
    writeBeforePrompt(api.getContext());
    rl.prompt();
  };

  const onLine = (line: string) => {
    const trimmed = line.trim();
    if (trimmed) {
      api.submit(trimmed);
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
