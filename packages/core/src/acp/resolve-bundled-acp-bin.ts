import { accessSync, constants } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { dirname, isAbsolute, join } from 'node:path';
import type { BuiltinAcpPresetId } from './resolve-acp-spawn.js';
import {
  ACP_PRESET_BIN_NAMES,
  ACP_PRESET_OPTIONAL_PACKAGES,
} from './acp-preset-bins.js';

/** `@agents-ensemble/core` の optionalDependencies 同梱 bin を解決。 */
export function resolveBundledAcpBin(
  preset: Exclude<BuiltinAcpPresetId, 'cursor'>,
  fromModuleUrl: string | URL = import.meta.url,
): string | undefined {
  try {
    const require = createRequire(fromModuleUrl);
    const { packageName, binName } = ACP_PRESET_OPTIONAL_PACKAGES[preset];
    const coreEntry = require.resolve('@agents-ensemble/core');
    const packageJsonPath = require.resolve(`${packageName}/package.json`, {
      paths: [dirname(coreEntry)],
    });
    const packageDirectory = dirname(packageJsonPath);
    const pkg = require(packageJsonPath) as {
      bin?: string | Record<string, string>;
    };
    const binRelative =
      typeof pkg.bin === 'string' ? pkg.bin : pkg.bin?.[binName];
    if (!binRelative) {
      return undefined;
    }
    const binPath = join(packageDirectory, binRelative);
    accessSync(binPath, constants.X_OK);
    return binPath;
  } catch {
    return undefined;
  }
}

/** PATH 上の実行ファイルを探す。 */
export function resolveAcpBinFromPath(binName: string): string | undefined {
  try {
    const output =
      process.platform === 'win32'
        ? execFileSync('where', [binName], { encoding: 'utf8' })
        : execFileSync('which', [binName], { encoding: 'utf8' });
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
 * built-in preset の ACP bin を解決する。
 * 順: optionalDependencies 同梱 bin → PATH 上の同名 bin。
 */
export function resolveAcpBin(
  preset: BuiltinAcpPresetId,
  fromModuleUrl: string | URL = import.meta.url,
): string | undefined {
  if (preset === 'cursor') {
    return resolveAcpBinFromPath(ACP_PRESET_BIN_NAMES.cursor);
  }

  const bundled = resolveBundledAcpBin(preset, fromModuleUrl);
  if (bundled) {
    return bundled;
  }

  return resolveAcpBinFromPath(ACP_PRESET_BIN_NAMES[preset]);
}
