import { accessSync, constants } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { dirname, isAbsolute, join } from 'node:path';

const RIPGREP_ENV = 'CURSOR_RIPGREP_PATH';

/** `@cursor/sdk-<platform>-<arch>/bin/rg` の絶対パス。見つからなければ undefined。 */
export function resolveBundledSdkRipgrepPath(
  fromModuleUrl: string | URL = import.meta.url,
): string | undefined {
  try {
    const require = createRequire(fromModuleUrl);
    const platformPackage = `@cursor/sdk-${process.platform}-${process.arch}`;
    const sdkEntry = require.resolve('@cursor/sdk');
    const packageDirectory = dirname(
      require.resolve(`${platformPackage}/package.json`, {
        paths: [dirname(sdkEntry)],
      }),
    );
    const binary = process.platform === 'win32' ? 'rg.exe' : 'rg';
    const ripgrepPath = join(packageDirectory, 'bin', binary);
    accessSync(ripgrepPath, constants.X_OK);
    return ripgrepPath;
  } catch {
    return undefined;
  }
}

/** PATH 上の `rg` を探す。SDK の `resolveRipgrepFromPath` と同趣旨。 */
export function resolveRipgrepFromPath(): string | undefined {
  try {
    const output =
      process.platform === 'win32'
        ? execFileSync('where', ['rg'], { encoding: 'utf8' })
        : execFileSync('which', ['rg'], { encoding: 'utf8' });
    const candidate = output.trim().split(/\r?\n/)[0]?.trim();
    if (candidate && isAbsolute(candidate)) {
      accessSync(candidate, constants.X_OK);
      return candidate;
    }
  } catch {
    // not on PATH
  }
  return undefined;
}

/**
 * local agent の workspace scan（`.gitignore` / `.cursorignore`）用に
 * `CURSOR_RIPGREP_PATH` を設定する。`Agent.create` より前に呼ぶこと。
 *
 * 解決順: 既存の絶対パス env → SDK 同梱 rg → PATH の rg。
 */
export function ensureCursorSdkRipgrepPath(): string | undefined {
  const configured = process.env[RIPGREP_ENV];
  if (configured && isAbsolute(configured)) {
    return configured;
  }

  const bundled = resolveBundledSdkRipgrepPath();
  if (bundled) {
    process.env[RIPGREP_ENV] = bundled;
    return bundled;
  }

  const fromPath = resolveRipgrepFromPath();
  if (fromPath) {
    process.env[RIPGREP_ENV] = fromPath;
    return fromPath;
  }

  return undefined;
}
