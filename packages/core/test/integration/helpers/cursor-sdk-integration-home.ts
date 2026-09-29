import {
  accessSync,
  constants,
  copyFileSync,
  existsSync,
  mkdtempSync,
  mkdirSync,
  rmSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { getDefaultSdkAuthPath } from '@cursor/sdk';
import { hasConductorAuth } from '../../../src/conductor/conductor-auth.js';

const ISOLATED_HOME_ENV = 'ENSEMBLE_INTEGRATION_HOME';
const SKIP_REASON_ENV = 'ENSEMBLE_CURSOR_SDK_INTEGRATION_SKIP';
const SKIP_LOGGED_ENV = 'ENSEMBLE_CURSOR_SDK_INTEGRATION_SKIP_LOGGED';

/**
 * Isolate every integration test file from the operator's home before Vitest
 * imports the test modules.
 */
function prepareIsolatedHome(): void {
  if (process.env[ISOLATED_HOME_ENV] || process.env[SKIP_REASON_ENV]) {
    return;
  }

  const originalAuthPath = getDefaultSdkAuthPath();
  let isolatedHome: string | undefined;

  try {
    isolatedHome = mkdtempSync(join(tmpdir(), 'agents-ensemble-integration-home-'));
    process.once('exit', () => {
      rmSync(isolatedHome!, { recursive: true, force: true });
    });

    accessSync(isolatedHome, constants.R_OK | constants.W_OK | constants.X_OK);
    const writeProbe = join(isolatedHome, '.write-probe');
    writeFileSync(writeProbe, '');
    unlinkSync(writeProbe);

    process.env.HOME = isolatedHome;
    if (process.platform === 'win32') {
      process.env.USERPROFILE = isolatedHome;
      process.env.APPDATA = join(isolatedHome, 'AppData', 'Roaming');
      process.env.LOCALAPPDATA = join(isolatedHome, 'AppData', 'Local');
    }
    process.env.XDG_CONFIG_HOME = join(isolatedHome, '.config');
    process.env.XDG_DATA_HOME = join(isolatedHome, '.local', 'share');
    process.env.XDG_STATE_HOME = join(isolatedHome, '.local', 'state');
    process.env.XDG_CACHE_HOME = join(isolatedHome, '.cache');

    const isolatedAuthPath = getDefaultSdkAuthPath();
    if (resolve(originalAuthPath) === resolve(isolatedAuthPath)) {
      throw new Error('Cursor SDK auth path did not follow the isolated HOME');
    }

    if (existsSync(originalAuthPath)) {
      mkdirSync(dirname(isolatedAuthPath), { recursive: true });
      copyFileSync(originalAuthPath, isolatedAuthPath);
    }

    if (!hasConductorAuth()) {
      throw new Error(
        'Cursor SDK authentication is unavailable; set CURSOR_API_KEY or log in with the Cursor SDK',
      );
    }

    process.env[ISOLATED_HOME_ENV] = isolatedHome;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    process.env[SKIP_REASON_ENV] = message.startsWith(
      'Cursor SDK authentication is unavailable',
    )
      ? message
      : `isolated HOME is unavailable (sandbox or write permission): ${message}`;
  }
}

prepareIsolatedHome();

/** A reason for skipping tests that require the real Cursor SDK, if any. */
export const cursorSdkIntegrationSkipReason = process.env[SKIP_REASON_ENV];

if (
  cursorSdkIntegrationSkipReason &&
  !process.env[SKIP_LOGGED_ENV]
) {
  console.info(
    `[integration skip] Cursor SDK tests: ${cursorSdkIntegrationSkipReason}`,
  );
  process.env[SKIP_LOGGED_ENV] = '1';
}
