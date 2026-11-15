import { posix, win32 } from 'node:path';

const XDG_CONFIG_PLATFORMS = new Set([
  'linux',
  'freebsd',
  'openbsd',
  'netbsd',
  'dragonfly',
]);

export interface CursorConfigRootOptions {
  acpCwd: string;
  platform: string;
  cursorConfigDir?: string;
  xdgConfigHome?: string;
  homeDirectory: string;
}

export function resolveCursorConfigRoot({
  acpCwd,
  platform,
  cursorConfigDir,
  xdgConfigHome,
  homeDirectory,
}: CursorConfigRootOptions): string {
  const path = platform === 'win32' ? win32 : posix;
  const configuredRoot = cursorConfigDir?.trim();
  if (configuredRoot) return path.resolve(acpCwd, configuredRoot);

  const xdgHome = xdgConfigHome?.trim();
  if (XDG_CONFIG_PLATFORMS.has(platform) && xdgHome) {
    return path.join(path.resolve(acpCwd, xdgHome), 'cursor');
  }

  return path.join(homeDirectory, '.cursor');
}
