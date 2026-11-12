import { homedir } from 'node:os'
import { dirname, isAbsolute, join, resolve } from 'node:path'

/**
 * Storage owned by the ACP adapter.
 *
 * We intentionally keep this separate from pi's own ~/.pi/agent/* directory.
 */
export function getPiAcpDir(): string {
  const sessionMapPath = process.env.PI_ACP_SESSION_MAP_PATH?.trim()
  if (sessionMapPath) return dirname(resolve(sessionMapPath))
  return join(homedir(), '.pi', 'pi-acp')
}

export function getPiAcpSessionMapPath(): string {
  const override = process.env.PI_ACP_SESSION_MAP_PATH?.trim()
  if (override) return isAbsolute(override) ? override : resolve(override)
  return join(getPiAcpDir(), 'session-map.json')
}
