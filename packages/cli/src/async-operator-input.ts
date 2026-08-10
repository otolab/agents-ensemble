import * as readline from 'node:readline/promises';
import { stdin as input, stderr, stdout as output } from 'node:process';
import type { OperatorInputBindingApi, OperatorInputContext } from '@agents-ensemble/core';

const OPERATOR_MESSAGE_ENV = 'ENSEMBLE_OPERATOR_MESSAGE';

function writeOpenQuestionHint(context: OperatorInputContext): void {
  const { openQuestions } = context;
  if (openQuestions.length === 0) {
    return;
  }
  stderr.write('\n未回答のオペレータ質問:\n');
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
    '\nオペレータ入力: 任意のタイミングで入力して Enter（@inq:<id> <回答>）。conductor は継続します。\n',
  );
  writeOpenQuestionHint(api.getContext());

  const rl = readline.createInterface({ input, output, terminal: true });
  rl.setPrompt('operator> ');

  const onLine = (line: string) => {
    const trimmed = line.trim();
    if (trimmed) {
      api.submit(trimmed);
      writeOpenQuestionHint(api.getContext());
    }
    rl.prompt();
  };

  rl.on('line', onLine);
  rl.prompt();

  return () => {
    rl.off('line', onLine);
    rl.close();
  };
}
