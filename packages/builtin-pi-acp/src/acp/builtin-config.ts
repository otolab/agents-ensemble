import {
  constants,
  copyFileSync,
  existsSync,
  mkdirSync,
} from 'node:fs'
import { homedir } from 'node:os'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

export interface EnsureBuiltinPiConfigOptions {
  agentDir?: string
  defaultsPath?: string
}

function bundledDefaultsPath(): string {
  const candidates = [
    new URL('../defaults/settings.json', import.meta.url),
    new URL('../../defaults/settings.json', import.meta.url),
  ]
  const path = candidates
    .map(candidate => fileURLToPath(candidate))
    .find(candidate => existsSync(candidate))
  if (!path) {
    throw new Error('builtin-pi-acp: bundled Pi settings.json is missing.')
  }
  return path
}

/**
 * Install the bundled Pi defaults for the builtin runtime without replacing
 * settings that the user has already created.
 */
export function ensureBuiltinPiConfig(
  options: EnsureBuiltinPiConfigOptions = {},
): void {
  const agentDir = resolve(
    options.agentDir ??
      process.env.PI_CODING_AGENT_DIR ??
      join(homedir(), '.pi', 'agent'),
  )
  const settingsPath = join(agentDir, 'settings.json')
  const defaultsPath = options.defaultsPath ?? bundledDefaultsPath()

  mkdirSync(agentDir, { recursive: true })
  try {
    copyFileSync(defaultsPath, settingsPath, constants.COPYFILE_EXCL)
  } catch (error) {
    if (
      error &&
      typeof error === 'object' &&
      'code' in error &&
      error.code === 'EEXIST'
    ) {
      return
    }
    throw error
  }
}
