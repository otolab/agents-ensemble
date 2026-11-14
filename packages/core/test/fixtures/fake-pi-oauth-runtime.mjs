import { writeFile } from 'node:fs/promises';
import { ModelRuntime } from '@earendil-works/pi-coding-agent';

const resultPath = process.env.ENSEMBLE_AUTH_FIXTURE_RESULT;
if (!resultPath) {
  throw new Error('ENSEMBLE_AUTH_FIXTURE_RESULT is required by the fake Pi runtime.');
}

ModelRuntime.prototype.login = async function (provider, method, interaction) {
  interaction.notify({
    type: 'auth_url',
    url: 'https://auth.example.test/authorize?state=cli-e2e',
    instructions: 'Open this URL on a device with a browser.',
  });
  const authorizationCode = await interaction.prompt({
    type: 'manual_code',
    message: 'Paste the authorization code',
    placeholder: 'authorization code',
  });
  await writeFile(
    resultPath,
    `${JSON.stringify({ provider, method, authorizationCode })}\n`,
  );
};
