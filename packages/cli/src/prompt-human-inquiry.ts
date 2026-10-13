import * as readline from 'node:readline/promises';
import { stdin as input, stdout as output } from 'node:process';
import {
  createPermissionAskHandler,
  EscalationUnavailableError,
  parseHumanInquiryAnswer,
  resolveHumanInquiryFromEnv,
  escalationUnavailableMessage,
  type HumanInquiryRequest,
  type HumanInquiryResponse,
} from '@agents-ensemble/core';

export async function promptHumanInquiry(
  request: HumanInquiryRequest,
): Promise<HumanInquiryResponse> {
  const fromEnv = resolveHumanInquiryFromEnv(request);
  if (fromEnv) {
    return fromEnv;
  }

  if (!input.isTTY) {
    throw new EscalationUnavailableError(escalationUnavailableMessage());
  }

  const rl = readline.createInterface({ input, output });
  try {
    if (request.context) {
      output.write(`\n${request.context}\n\n`);
    }

    if (request.responseType === 'yes_no') {
      const answer = await rl.question(`${request.question} [y/N]: `);
      return parseHumanInquiryAnswer(answer, request);
    }

    if (request.responseType === 'choice') {
      const choices = request.choices ?? [];
      if (choices.length === 0) {
        throw new Error('choice human inquiry requires at least one choice');
      }
      const options = choices.map(({ id, label }) => `  ${id}: ${label}`).join('\n');
      const answer = await rl.question(`${request.question}\n${options}\n> `);
      return parseHumanInquiryAnswer(answer, request);
    }

    const answer = await rl.question(`${request.question}\n> `);
    return { answer: answer.trim() };
  } finally {
    rl.close();
  }
}
