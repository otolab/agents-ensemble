import { basename } from 'node:path';
import type { AcpPresetId, ResolvedAcpSpawn } from './resolve-acp-spawn.js';

/** ACP `authenticate` リクエストの扱い。 */
export type AcpAuthenticateStrategy =
  | { kind: 'method'; methodId: string }
  | { kind: 'skip' };

/** profile `acp.authenticate` 文字列を戦略へ。`skip` または method id（例: `chat-gpt`）。 */
export function parseProfileAcpAuthenticate(
  value: string,
  label?: string,
): AcpAuthenticateStrategy {
  const trimmed = value.trim();
  if (!trimmed) {
    throw new Error(
      `Invalid profile acp.authenticate${label ? ` in ${label}` : ''}: empty string`,
    );
  }
  if (trimmed === 'skip') {
    return { kind: 'skip' };
  }
  return { kind: 'method', methodId: trimmed };
}

/** built-in preset ごとのデフォルト authenticate 戦略。 */
export function resolveBuiltinAcpAuthenticateStrategy(
  preset: Exclude<AcpPresetId, 'custom'>,
): AcpAuthenticateStrategy {
  switch (preset) {
    case 'cursor':
      return { kind: 'method', methodId: 'cursor_login' };
    case 'codex':
      // ADR 0028: 既定は移譲。管理モードは profile `acp.authenticate` で opt-in
      return { kind: 'skip' };
    case 'claude':
      // claude-agent-acp: terminal / gateway 以外は未実装。CLI ログイン済みなら skip で session/new 可
      return { kind: 'skip' };
    case 'pi':
      // pi-acp: authenticate は no-op。pi CLI 側の設定を session 開始時に利用
      return { kind: 'skip' };
  }
}

function isCursorAgentAcpSpawn(command: string, args: string[]): boolean {
  return basename(command) === 'agent' && args.length === 1 && args[0] === 'acp';
}

/** spawn 解決結果から ACP connect 時の authenticate 戦略を決める。 */
export function resolveAcpAuthenticateStrategy(
  spawn: Pick<ResolvedAcpSpawn, 'preset' | 'command' | 'args'>,
): AcpAuthenticateStrategy {
  if (spawn.preset === 'custom') {
    if (isCursorAgentAcpSpawn(spawn.command, spawn.args)) {
      return { kind: 'method', methodId: 'cursor_login' };
    }
    return { kind: 'skip' };
  }

  return resolveBuiltinAcpAuthenticateStrategy(spawn.preset);
}
