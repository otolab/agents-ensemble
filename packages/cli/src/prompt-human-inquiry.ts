import * as readline from 'node:readline/promises';
import { stdin as input, stdout as output } from 'node:process';
import {
  createPermissionAskHandler,
  EscalationUnavailableError,
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
      const approved = answer.trim().toLowerCase().startsWith('y');
      return { answer: answer.trim(), approved };
    }

    const answer = await rl.question(`${request.question}\n> `);
    return { answer: answer.trim() };
  } finally {
    rl.close();
  }
}
