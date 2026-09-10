import { configureCursorSdk } from '@cursor/sdk';
import { accessSync, constants, readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { homedir } from 'node:os';
import { dirname, isAbsolute, join } from 'node:path';

const RIPGREP_ENV = 'CURSOR_RIPGREP_PATH';
const HTTP_PROXY_ENV = 'HTTP_PROXY';
const HTTPS_PROXY_ENV = 'HTTPS_PROXY';
const NO_PROXY_ENV = 'NO_PROXY';

export interface CursorSettings {
  'cursor.general.disableHttp2'?: unknown;
  'http.noProxy'?: unknown;
  'http.proxy'?: unknown;
  http?: {
    noProxy?: unknown;
    proxy?: unknown;
  };
  cursor?: {
    general?: {
      disableHttp2?: unknown;
    };
  };
}

export interface CursorSdkEnvOptions {
  appData?: string;
  env?: NodeJS.ProcessEnv;
  homeDir?: string;
  platform?: NodeJS.Platform;
  settingsPath?: string;
}

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

/** Cursor IDE の settings.json の標準パスを返す。 */
export function resolveCursorSettingsPath(
  options: Pick<
    CursorSdkEnvOptions,
    'appData' | 'env' | 'homeDir' | 'platform'
  > = {},
): string | undefined {
  const platform = options.platform ?? process.platform;
  const home = options.homeDir ?? homedir();

  switch (platform) {
    case 'darwin':
      return join(
        home,
        'Library',
        'Application Support',
        'Cursor',
        'User',
        'settings.json',
      );
    case 'linux':
      return join(home, '.config', 'Cursor', 'User', 'settings.json');
    case 'win32': {
      const env = options.env ?? process.env;
      const appData = options.appData ?? env.APPDATA;
      return appData
        ? join(appData, 'Cursor', 'User', 'settings.json')
        : undefined;
    }
    default:
      return undefined;
  }
}

function stripJsonComments(source: string): string {
  let result = '';
  let inString = false;
  let escaped = false;
  let inLineComment = false;
  let inBlockComment = false;

  for (let index = 0; index < source.length; index += 1) {
    const character = source[index];
    const nextCharacter = source[index + 1];

    if (inLineComment) {
      if (character === '\n' || character === '\r') {
        inLineComment = false;
        result += character;
      } else {
        result += ' ';
      }
      continue;
    }

    if (inBlockComment) {
      if (character === '*' && nextCharacter === '/') {
        inBlockComment = false;
        result += '  ';
        index += 1;
      } else {
        result += character === '\n' || character === '\r' ? character : ' ';
      }
      continue;
    }

    if (inString) {
      result += character;
      if (escaped) {
        escaped = false;
      } else if (character === '\\') {
        escaped = true;
      } else if (character === '"') {
        inString = false;
      }
      continue;
    }

    if (character === '"') {
      inString = true;
      result += character;
    } else if (character === '/' && nextCharacter === '/') {
      inLineComment = true;
      result += '  ';
      index += 1;
    } else if (character === '/' && nextCharacter === '*') {
      inBlockComment = true;
      result += '  ';
      index += 1;
    } else {
      result += character;
    }
  }

  return result;
}

function stripTrailingCommas(source: string): string {
  let result = '';
  let inString = false;
  let escaped = false;

  for (let index = 0; index < source.length; index += 1) {
    const character = source[index];

    if (inString) {
      result += character;
      if (escaped) {
        escaped = false;
      } else if (character === '\\') {
        escaped = true;
      } else if (character === '"') {
        inString = false;
      }
      continue;
    }

    if (character === '"') {
      inString = true;
      result += character;
      continue;
    }

    if (character === ',') {
      let nextIndex = index + 1;
      while (/\s/.test(source[nextIndex] ?? '')) {
        nextIndex += 1;
      }
      if (source[nextIndex] === '}' || source[nextIndex] === ']') {
        continue;
      }
    }

    result += character;
  }

  return result;
}

/** Cursor の JSON/JSONC 設定を読み、読めない場合は undefined を返す。 */
export function readCursorSettings(
  settingsPath: string,
): CursorSettings | undefined {
  try {
    const source = readFileSync(settingsPath, 'utf8');
    const json = stripTrailingCommas(stripJsonComments(source));
    const parsed: unknown = JSON.parse(json);
    return isRecord(parsed) ? (parsed as CursorSettings) : undefined;
  } catch {
    return undefined;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function setEnvironmentValueIfUnset(
  env: NodeJS.ProcessEnv,
  name: string,
  value: string | undefined,
): void {
  if (env[name] !== undefined) {
    return;
  }

  const lowercaseName = name.toLowerCase();
  if (env[lowercaseName] !== undefined) {
    env[name] = env[lowercaseName];
    return;
  }

  if (value === undefined) {
    return;
  }
  env[name] = value;
}

function resolveSettingString(value: unknown): string | undefined {
  if (typeof value === 'string') {
    const trimmed = value.trim();
    return trimmed ? trimmed : undefined;
  }
  if (
    Array.isArray(value) &&
    value.length > 0 &&
    value.every((entry) => typeof entry === 'string')
  ) {
    const joined = value.join(',').trim();
    return joined ? joined : undefined;
  }
  return undefined;
}

function resolveCursorSetting(
  settings: CursorSettings,
  flatKey: keyof CursorSettings,
  nestedValue: unknown,
): unknown {
  return Object.prototype.hasOwnProperty.call(settings, flatKey)
    ? settings[flatKey]
    : nestedValue;
}

/** Cursor settings の proxy 関連設定を SDK の起動環境へ反映する。 */
export function ensureCursorSdkProxy(
  options: CursorSdkEnvOptions = {},
): void {
  const env = options.env ?? process.env;
  const settingsPath =
    options.settingsPath ?? resolveCursorSettingsPath(options);
  const settings = settingsPath
    ? readCursorSettings(settingsPath)
    : undefined;

  if (!settings) {
    return;
  }

  const proxy = resolveSettingString(
    resolveCursorSetting(settings, 'http.proxy', settings.http?.proxy),
  );
  setEnvironmentValueIfUnset(env, HTTP_PROXY_ENV, proxy);
  setEnvironmentValueIfUnset(env, HTTPS_PROXY_ENV, proxy);
  setEnvironmentValueIfUnset(
    env,
    NO_PROXY_ENV,
    resolveSettingString(
      resolveCursorSetting(settings, 'http.noProxy', settings.http?.noProxy),
    ),
  );

  if (
    resolveCursorSetting(
      settings,
      'cursor.general.disableHttp2',
      settings.cursor?.general?.disableHttp2,
    ) === true
  ) {
    configureCursorSdk({ local: { useHttp1ForAgent: true } });
  }
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
