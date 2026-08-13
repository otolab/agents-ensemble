/**
 * 実 `agent acp`（protocolVersion 1）で観測した `sessionUpdate` 値。
 * Issue #148 調査正本。未知の値も forward-compat のため受け入れる。
 */
export const KNOWN_ACP_SESSION_UPDATE_KINDS = [
  'agent_message_chunk',
  'agent_thought_chunk',
  'user_message_chunk',
  'tool_call',
  'tool_call_update',
  'plan',
  'current_mode_update',
  'available_commands_update',
  'session_info_update',
] as const;

export type KnownAcpSessionUpdateKind =
  (typeof KNOWN_ACP_SESSION_UPDATE_KINDS)[number];

/** ACP `session/update` の `update.sessionUpdate` 文字列。 */
export type AcpSessionUpdateKind = KnownAcpSessionUpdateKind | (string & {});
