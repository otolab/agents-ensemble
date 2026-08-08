import * as readline from 'node:readline/promises';
import { stdin as input, stdout as output } from 'node:process';
import type { OperatorInputContext } from '@agents-ensemble/core';

const OPERATOR_MESSAGE_ENV = 'ENSEMBLE_OPERATOR_MESSAGE';

export async function promptOperatorInput(
  context: OperatorInputContext,
): Promise<string | undefined> {
  const fromEnv = process.env[OPERATOR_MESSAGE_ENV]?.trim();
  if (fromEnv) {
    return fromEnv;
  }

  if (!input.isTTY) {
    return undefined;
  }

  if (context.openQuestions.length > 0) {
    output.write('\n未回答のオペレータ質問:\n');
    for (const question of context.openQuestions) {
      output.write(
        `- ${question.id} [${question.responseType}] ${question.question}\n`,
      );
      if (question.context) {
        output.write(`  ${question.context}\n`);
      }
    }
  }

  const rl = readline.createInterface({ input, output });
  try {
    const prompt =
      context.openQuestions.length > 0
        ? '\nオペレータ入力（空でスキップ、@inq:<id> <回答> で特定）:\n> '
        : '\nオペレータ入力（空でスキップ。自由な指示も可）:\n> ';
    const answer = await rl.question(prompt);
    const trimmed = answer.trim();
    return trimmed || undefined;
  } finally {
    rl.close();
  }
}
