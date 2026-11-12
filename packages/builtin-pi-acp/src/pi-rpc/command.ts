import { platform } from 'node:os'
import { extname } from 'node:path'

export function defaultPiCommand(): string {
  return platform() === 'win32' ? 'pi.cmd' : 'pi'
}

export function getPiCommand(override?: string): string {
  return override ?? defaultPiCommand()
}

export function shouldUseShellForPiCommand(cmd: string): boolean {
  if (platform() !== 'win32') return false

  const normalized = cmd.trim().toLowerCase()
  return normalized.endsWith('.cmd') || normalized.endsWith('.bat')
}

export interface PiCommandInvocation {
  command: string
  args: string[]
  shell: boolean
}

/** Run a resolved JS CLI entrypoint with Node so builtin Pi also works on Windows. */
export function resolvePiCommandInvocation(
  override?: string,
): PiCommandInvocation {
  const command = getPiCommand(override)
  const extension = extname(command).toLowerCase()
  if (extension === '.js' || extension === '.mjs' || extension === '.cjs') {
    return {
      command: process.execPath,
      args: [command],
      shell: false,
    }
  }

  return {
    command,
    args: [],
    shell: shouldUseShellForPiCommand(command),
  }
}
