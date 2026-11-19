import type { AcpPresetId, BuiltinAcpPresetId, ResolvedAcpSpawn } from './resolve-acp-spawn.js';
import { isBuiltinAcpPresetId } from './resolve-acp-spawn.js';
import {
  ACP_PRESET_BIN_NAMES,
  ACP_PRESET_EXTERNAL_CLI,
  ACP_PRESET_ADAPTER_PACKAGES,
} from './acp-preset-bins.js';
import {
  assertBuiltinPiNodeVersionSupported,
  resolveBuiltinPiAcpEntrypointPath,
  resolveBuiltinPiAcpWrapperPath,
  resolveBuiltinPiCliEnvWrapperPath,
  resolveBundledPiCliPath,
} from './pi-runtime.js';
import {
  resolveAcpBin,
  resolveAcpBinFromPath,
  resolveBundledAcpBin,
} from './resolve-bundled-acp-bin.js';

export class AcpPresetPrerequisiteError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'AcpPresetPrerequisiteError';
  }
}

/** preset 別の install 手順（CONDUCTOR_AUTH_HINT と同趣旨）。 */
export function formatAcpPresetInstallHint(preset: AcpPresetId): string {
  switch (preset) {
    case 'cursor':
      return (
        '[acp] cursor preset: Cursor Agent CLI (`agent`) が PATH にありません。\n' +
        '  https://cursor.com/docs/cli を参照してインストールし、`agent login` を実行してください。'
      );
    case 'claude':
    case 'codex':
    case 'pi': {
      const { packageName, binName } = ACP_PRESET_ADAPTER_PACKAGES[preset];
      return (
        `[acp] ${preset} preset: core 同梱 ACP adapter \`${binName}\`（${packageName}）を解決できません。package の欠落、bin 定義または実行権限を確認してください。\n` +
        '  開発環境では `pnpm install`、npm インストールでは ensemble の再インストールを試してください（optional dependency を含む）。\n' +
        `  PATH 上の adapter を使う場合は \`--default-acp-command ${binName}\` を明示してください。`
      );
    }
    case 'custom':
      return (
        '[acp] custom preset: 指定した command が PATH にありません。\n' +
        '  profile / CLI で指定した実行ファイルをインストールするか、絶対パスを指定してください。'
      );
    default:
      return `[acp] Unknown ACP preset "${preset}".`;
  }
}

export function formatAcpExternalCliInstallHint(
  preset: BuiltinAcpPresetId,
  cliName: string,
): string {
  if (preset === 'pi') {
    return (
      `[acp] pi preset: \`pi\` CLI が PATH にありません（\`${ACP_PRESET_BIN_NAMES.pi}\` は見つかりました）。\n` +
      '  `@earendil-works/pi-coding-agent`（v0.80.4+）をインストールしてください（ADR 0019 参照）。\n' +
      '  モデル/API key は `pi` 側で別途設定してください。'
    );
  }

  return (
    `[acp] ${preset} preset: 外部 CLI \`${cliName}\` が PATH にありません。\n` +
    '  必要な CLI をインストールして PATH に追加してください。'
  );
}

function validateBuiltinPreset(
  preset: Exclude<AcpPresetId, 'custom'>,
  piRuntime: ResolvedAcpSpawn['piRuntime'],
  fromModuleUrl?: string | URL,
): void {
  const moduleUrl = fromModuleUrl ?? import.meta.url;

  if (preset === 'pi' && piRuntime === 'builtin') {
    try {
      resolveBuiltinPiAcpEntrypointPath(moduleUrl);
      assertBuiltinPiNodeVersionSupported();
      resolveBundledPiCliPath(moduleUrl);
      resolveBuiltinPiAcpWrapperPath();
      resolveBuiltinPiCliEnvWrapperPath(moduleUrl);
    } catch (error) {
      throw new AcpPresetPrerequisiteError(
        error instanceof Error ? error.message : String(error),
      );
    }
    return;
  }

  if (preset === 'cursor') {
    if (!resolveAcpBinFromPath(ACP_PRESET_BIN_NAMES.cursor)) {
      throw new AcpPresetPrerequisiteError(formatAcpPresetInstallHint('cursor'));
    }
    return;
  }

  const bundled = resolveBundledAcpBin(preset, moduleUrl);

  if (!bundled) {
    throw new AcpPresetPrerequisiteError(formatAcpPresetInstallHint(preset));
  }

  const externalCli = ACP_PRESET_EXTERNAL_CLI[preset];
  if (externalCli && !resolveAcpBinFromPath(externalCli)) {
    throw new AcpPresetPrerequisiteError(
      formatAcpExternalCliInstallHint(preset, externalCli),
    );
  }
}

/** spawn 前に preset 前提（同梱 adapter / 外部 CLI）を検証する。 */
export function validateAcpPresetPrerequisites(
  spawn: ResolvedAcpSpawn,
  options?: { fromModuleUrl?: string | URL },
): void {
  if (spawn.preset === 'custom') {
    if (!resolveAcpBinFromPath(spawn.command)) {
      throw new AcpPresetPrerequisiteError(
        `${formatAcpPresetInstallHint('custom')}\n  command: ${spawn.command}`,
      );
    }
    return;
  }

  if (!isBuiltinAcpPresetId(spawn.preset)) {
    throw new AcpPresetPrerequisiteError(
      `[acp] Unknown ACP preset "${spawn.preset}".`,
    );
  }

  validateBuiltinPreset(
    spawn.preset,
    spawn.piRuntime,
    options?.fromModuleUrl,
  );
}

/** 検証済み spawn の command を bundled / PATH 解決後の絶対パスへ置き換える。 */
export function resolveAcpSpawnExecutable(
  spawn: ResolvedAcpSpawn,
  options?: { fromModuleUrl?: string | URL },
): ResolvedAcpSpawn {
  if (spawn.preset === 'custom') {
    const fromPath = resolveAcpBinFromPath(spawn.command);
    return fromPath ? { ...spawn, command: fromPath } : spawn;
  }

  if (!isBuiltinAcpPresetId(spawn.preset)) {
    throw new Error(`Unknown ACP preset "${spawn.preset}"`);
  }

  if (spawn.preset === 'pi' && spawn.piRuntime === 'builtin') {
    return {
      ...spawn,
      command: process.execPath,
      args: [resolveBuiltinPiAcpWrapperPath(), ...spawn.args],
    };
  }

  const resolved = resolveAcpBin(spawn.preset, options?.fromModuleUrl ?? import.meta.url);
  if (!resolved) {
    throw new AcpPresetPrerequisiteError(formatAcpPresetInstallHint(spawn.preset));
  }

  return {
    ...spawn,
    command: resolved,
  };
}

/** validate → resolve を 1 段で行う（ensemble issue 起動前）。 */
export function finalizeResolvedAcpSpawn(
  spawn: ResolvedAcpSpawn,
  options?: { fromModuleUrl?: string | URL },
): ResolvedAcpSpawn {
  validateAcpPresetPrerequisites(spawn, options);
  return resolveAcpSpawnExecutable(spawn, options);
}

/** 重複 preset を除き、全 worker spawn の前提を検証する。 */
export function validateWorkerAcpPrerequisites(
  spawns: Iterable<ResolvedAcpSpawn>,
  options?: { fromModuleUrl?: string | URL },
): void {
  const seen = new Set<string>();
  for (const spawn of spawns) {
    const key = `${spawn.preset}\0${spawn.command}\0${spawn.args.join('\0')}`;
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    validateAcpPresetPrerequisites(spawn, options);
  }
}
