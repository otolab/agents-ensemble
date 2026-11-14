import {
  constants,
  copyFileSync,
  existsSync,
  mkdirSync,
} from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export interface EnsureBuiltinPiConfigOptions {
  agentDir?: string;
  defaultsPath?: string;
}

function bundledDefaultsPath(): string {
  const path = fileURLToPath(
    new URL('../../assets/pi/settings.json', import.meta.url),
  );
  if (!existsSync(path)) {
    throw new Error('builtin Pi wrapper: bundled settings.json is missing.');
  }
  return path;
}

/**
 * Install the builtin Pi defaults only when the configured user root has no
 * settings file. Existing Pi settings remain the user's source of truth.
 */
export function ensureBuiltinPiConfig(
  options: EnsureBuiltinPiConfigOptions = {},
): void {
  const agentDir = resolve(
    options.agentDir ??
      process.env.PI_CODING_AGENT_DIR ??
      join(homedir(), '.pi', 'agent'),
  );
  const settingsPath = join(agentDir, 'settings.json');
  const defaultsPath = options.defaultsPath ?? bundledDefaultsPath();

  mkdirSync(agentDir, { recursive: true });
  try {
    copyFileSync(defaultsPath, settingsPath, constants.COPYFILE_EXCL);
  } catch (error) {
    if (
      error &&
      typeof error === 'object' &&
      'code' in error &&
      error.code === 'EEXIST'
    ) {
      return;
    }
    throw error;
  }
}
