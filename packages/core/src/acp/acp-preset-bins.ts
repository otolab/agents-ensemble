import type { BuiltinAcpPresetId } from './resolve-acp-spawn.js';

/** preset ごとの同梱 adapter package と bin 名。cursor は bundled なし。 */
export const ACP_PRESET_ADAPTER_PACKAGES: Record<
  Exclude<BuiltinAcpPresetId, 'cursor'>,
  { packageName: string; binName: string }
> = {
  claude: {
    packageName: '@agentclientprotocol/claude-agent-acp',
    binName: 'claude-agent-acp',
  },
  codex: {
    packageName: '@agentclientprotocol/codex-acp',
    binName: 'codex-acp',
  },
  pi: {
    packageName: 'pi-acp',
    binName: 'pi-acp',
  },
};

export const ACP_PRESET_BIN_NAMES: Record<BuiltinAcpPresetId, string> = {
  cursor: 'agent',
  claude: 'claude-agent-acp',
  codex: 'codex-acp',
  pi: 'pi-acp',
};

/** BYO runtime の pi preset が spawn 前に PATH 上で必要とする外部 CLI。 */
export const ACP_PRESET_EXTERNAL_CLI: Partial<Record<BuiltinAcpPresetId, string>> = {
  cursor: 'agent',
  pi: 'pi',
};
