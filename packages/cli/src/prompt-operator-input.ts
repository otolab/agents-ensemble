import * as readline from 'node:readline/promises';
import { stdin as input, stdout as output } from 'node:process';
import type { OperatorInputContext } from '@agents-ensemble/core';
import { formatIssueReference } from './tui/format-operator-context.js';

const OPERATOR_MESSAGE_ENV = 'ENSEMBLE_OPERATOR_MESSAGE';

/** TTY または `ENSEMBLE_OPERATOR_MESSAGE` でオペレータ入力が実際に届く環境か。 */
export function isOperatorInputInteractive(): boolean {
  if (process.env[OPERATOR_MESSAGE_ENV]?.trim()) {
    return true;
  }
  return process.stdin.isTTY ?? false;
}

/** post-loop 待機を有効にできる TTY 入力か（`ENSEMBLE_OPERATOR_MESSAGE` 単発注入は除外）。 */
export function isOperatorInputTty(): boolean {
  return process.stdin.isTTY ?? false;
}

function formatMaxTurnsLabel(maxTurns: number | null): string {
  return maxTurns === null ? '∞' : String(maxTurns);
}

export async function promptOperatorInput(
  context: OperatorInputContext,
  issueUrl?: string,
): Promise<string | undefined> {
  const fromEnv = process.env[OPERATOR_MESSAGE_ENV]?.trim();
  if (fromEnv) {
    return fromEnv;
  }

  if (!input.isTTY) {
    return undefined;
  }

  if (issueUrl) {
    output.write(`\nIssue: ${formatIssueReference(issueUrl, 'url')}\n`);
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
  } else {
    output.write(
      `\n自律ターン: ${context.autonomousTurns}/${formatMaxTurnsLabel(context.maxTurns)}（オペレータ入力でリセット）\n`,
    );
  }

  const rl = readline.createInterface({ input, output });
  try {
    const prompt =
      context.openQuestions.length > 0
        ? '\nオペレータ入力（空でスキップ。未回答 1 件ならそのまま回答）:\n> '
        : '\nオペレータ入力（空でスキップ。自由な指示も可）:\n> ';
    const answer = await rl.question(prompt);
    const trimmed = answer.trim();
    return trimmed || undefined;
  } finally {
    rl.close();
  }
}
