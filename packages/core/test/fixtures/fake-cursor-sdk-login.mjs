import { writeFile } from 'node:fs/promises';
import { Cursor } from '@cursor/sdk';

const resultPath = process.env.ENSEMBLE_AUTH_FIXTURE_RESULT;
if (!resultPath) {
  throw new Error('ENSEMBLE_AUTH_FIXTURE_RESULT is required by the fake Cursor login.');
}

Cursor.auth.login = async (...args) => {
  await writeFile(
    resultPath,
    `${JSON.stringify({ called: true, argumentCount: args.length })}\n`,
  );
  return {
    apiKey: 'fixture-only-cursor-api-key',
    email: 'fixture@example.test',
    apiKeyExpiresAtMs: 1_900_000_000_000,
  };
};
