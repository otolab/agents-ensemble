import type { AcpPresetId, BuiltinAcpPresetId, ResolvedAcpSpawn } from './resolve-acp-spawn.js';
import { isBuiltinAcpPresetId } from './resolve-acp-spawn.js';
import {
  ACP_PRESET_BIN_NAMES,
  ACP_PRESET_EXTERNAL_CLI,
  ACP_PRESET_OPTIONAL_PACKAGES,
} from './acp-preset-bins.js';
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
    case 'claude': {
      const { packageName, binName } = ACP_PRESET_OPTIONAL_PACKAGES.claude;
      return (
        `[acp] claude preset: ACP adapter \`${binName}\` が見つかりません。\n` +
        '  開発: リポジトリルートで `pnpm install`（optional 再試行）\n' +
        `  利用者: \`npm i -g ${packageName}\`\n` +
        `  または PATH 上に \`${binName}\` を配置してください。\n` +
        '  Claude Code の認証は adapter 側で別途必要です（ADR 0019 参照）。'
      );
    }
    case 'codex': {
      const { packageName, binName } = ACP_PRESET_OPTIONAL_PACKAGES.codex;
      return (
        `[acp] codex preset: ACP adapter \`${binName}\` が見つかりません。\n` +
        '  開発: リポジトリルートで `pnpm install`（optional 再試行）\n' +
        `  利用者: \`npm i -g ${packageName}\`\n` +
        `  または PATH 上に \`${binName}\` を配置してください。\n` +
        '  Codex の認証は adapter 側で別途必要です（ADR 0019 参照）。'
      );
    }
    case 'pi': {
      const { packageName, binName } = ACP_PRESET_OPTIONAL_PACKAGES.pi;
      return (
        `[acp] pi preset: ACP adapter \`${binName}\` が見つかりません。\n` +
        '  開発: リポジトリルートで `pnpm install`（optional 再試行）\n' +
        `  利用者: \`npm i -g ${packageName}\`\n` +
        `  または PATH 上に \`${binName}\` を配置してください。`
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
  fromModuleUrl?: string | URL,
): void {
  const moduleUrl = fromModuleUrl ?? import.meta.url;

  if (preset === 'cursor') {
    if (!resolveAcpBinFromPath(ACP_PRESET_BIN_NAMES.cursor)) {
      throw new AcpPresetPrerequisiteError(formatAcpPresetInstallHint('cursor'));
    }
    return;
  }

  const bundled = resolveBundledAcpBin(preset, moduleUrl);
  const fromPath = resolveAcpBinFromPath(ACP_PRESET_BIN_NAMES[preset]);
  if (!bundled && !fromPath) {
    throw new AcpPresetPrerequisiteError(formatAcpPresetInstallHint(preset));
  }

  const externalCli = ACP_PRESET_EXTERNAL_CLI[preset];
  if (externalCli && !resolveAcpBinFromPath(externalCli)) {
    throw new AcpPresetPrerequisiteError(
      formatAcpExternalCliInstallHint(preset, externalCli),
    );
  }
}

/** spawn 前に preset 前提（optional bin / 外部 CLI）を検証する。不足時は throw。 */
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

  validateBuiltinPreset(spawn.preset, options?.fromModuleUrl);
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
