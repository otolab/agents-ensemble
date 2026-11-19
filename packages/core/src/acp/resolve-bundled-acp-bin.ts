import { accessSync, constants, existsSync, readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { dirname, isAbsolute, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { BuiltinAcpPresetId } from './resolve-acp-spawn.js';
import {
  ACP_PRESET_ADAPTER_PACKAGES,
  ACP_PRESET_BIN_NAMES,
} from './acp-preset-bins.js';

/** `@agents-ensemble/core` dependency として同梱した adapter bin を解決。 */
export function resolveBundledAcpBin(
  preset: Exclude<BuiltinAcpPresetId, 'cursor'>,
  fromModuleUrl: string | URL = import.meta.url,
  onFailure?: (reason: string) => void,
): string | undefined {
  let stage = 'core package の探索';
  try {
    const require = createRequire(fromModuleUrl);
    const { packageName, binName } = ACP_PRESET_ADAPTER_PACKAGES[preset];
    const coreSearchPaths = require.resolve.paths('@agents-ensemble/core');
    let directory = dirname(fileURLToPath(fromModuleUrl));
    let ownCoreDirectory: string | undefined;
    while (true) {
      const manifest = join(directory, 'package.json');
      if (existsSync(manifest)) {
        try {
          if (JSON.parse(readFileSync(manifest, 'utf8')).name === '@agents-ensemble/core') {
            ownCoreDirectory = directory;
            break;
          }
        } catch { /* Keep searching for the core package. */ }
      }
      const parent = dirname(directory);
      if (parent === directory) break;
      directory = parent;
    }
    const corePackageDirectory = ownCoreDirectory ?? coreSearchPaths
      ?.map((nodeModulesPath) =>
        join(nodeModulesPath, '@agents-ensemble', 'core'),
      )
      .find((packageDirectory) =>
        existsSync(join(packageDirectory, 'package.json')),
      );
    if (!corePackageDirectory) {
      throw new Error('@agents-ensemble/core の package root が見つかりません');
    }
    stage = `adapter package ${packageName} の解決（起点: ${corePackageDirectory}）`;
    const packageJsonPath = require.resolve(`${packageName}/package.json`, {
      paths: [corePackageDirectory],
    });
    const packageDirectory = dirname(packageJsonPath);
    stage = `adapter manifest ${packageJsonPath} の読み取り`;
    const pkg = require(packageJsonPath) as {
      bin?: string | Record<string, string>;
    };
    const binRelative =
      typeof pkg.bin === 'string' ? pkg.bin : pkg.bin?.[binName];
    if (typeof binRelative !== 'string' || !binRelative) {
      throw new Error(`bin 定義に ${binName} がありません`);
    }
    const binPath = join(packageDirectory, binRelative);
    stage = `adapter bin ${binPath} の実行可能性の確認`;
    accessSync(binPath, constants.X_OK);
    return binPath;
  } catch (error) {
    onFailure?.(`${stage}: ${error instanceof Error ? error.message : String(error)}`);
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
 * cursor は PATH、それ以外は core dependency の同梱 bin。
 */
export function resolveAcpBin(
  preset: BuiltinAcpPresetId,
  fromModuleUrl: string | URL = import.meta.url,
  onFailure?: (reason: string) => void,
): string | undefined {
  if (preset === 'cursor') {
    return resolveAcpBinFromPath(ACP_PRESET_BIN_NAMES.cursor);
  }

  return resolveBundledAcpBin(preset, fromModuleUrl, onFailure);
}
