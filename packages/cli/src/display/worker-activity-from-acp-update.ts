const BROWSING_TOOL_NAMES = new Set([
  'WebFetch',
  'WebSearch',
  'Browser',
  'mcp_web_fetch',
]);

function isBrowsingTool(toolName: string): boolean {
  return BROWSING_TOOL_NAMES.has(toolName);
}

function formatToolActivity(
  verb: 'calling' | 'editing' | 'browsing',
  toolName?: string,
): string {
  if (toolName) {
    const category = isBrowsingTool(toolName) ? 'browsing' : verb;
    return `${category}: ${toolName}`;
  }
  return isBrowsingTool(toolName ?? '') ? 'browsing' : verb;
}

/**
 * ACP `sessionUpdate` から Workers ペイン用の活動ヒントを導出する。
 * chunk 連打を抑えるため、変化がない update 種別は `undefined` を返す。
 */
export function workerActivityFromAcpUpdate(
  sessionUpdate: string,
  toolName?: string,
): string | undefined {
  switch (sessionUpdate) {
    case 'agent_thought_chunk':
    case 'agent_message_chunk':
    case 'plan':
      return 'thinking';
    case 'tool_call':
      return formatToolActivity('calling', toolName);
    case 'tool_call_update':
      return formatToolActivity('editing', toolName);
    default:
      return undefined;
  }
}
