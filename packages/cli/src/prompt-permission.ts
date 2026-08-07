import * as readline from 'node:readline/promises';
import { stdin as input, stdout as output } from 'node:process';
import {
  allowOnce,
  deny,
  type PermissionRequest,
} from '@agents-ensemble/core';

export async function promptPermissionDecision(request: PermissionRequest) {
  if (!input.isTTY) {
    return allowOnce();
  }

  const rl = readline.createInterface({ input, output });
  try {
    const session = request.sessionId ? ` session=${request.sessionId}` : '';
    const answer = await rl.question(
      `Worker permission: ${request.toolName}${session}. Allow? [y/N]: `,
    );
    return answer.trim().toLowerCase().startsWith('y') ? allowOnce() : deny();
  } finally {
    rl.close();
  }
}
