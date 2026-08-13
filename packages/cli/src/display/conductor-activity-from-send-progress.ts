function capitalizeToolLabel(tool: string): string {
  if (tool.length === 0) {
    return tool;
  }
  return tool.charAt(0).toUpperCase() + tool.slice(1);
}

function isBrowsingTool(tool: string): boolean {
  const lower = tool.toLowerCase();
  return (
    lower.includes('webfetch') ||
    lower.includes('websearch') ||
    lower.includes('browser')
  );
}

/**
 * `conductor.send.progress` の tool 名から Workers ペイン用の活動ヒントを導出する。
 * 同一ツールの連打は reducer 側で抑止する。
 */
export function conductorActivityFromSendProgress(tool: string): string {
  const lower = tool.toLowerCase();

  switch (lower) {
    case 'read':
      return 'reading';
    case 'grep':
    case 'ripgrep':
      return 'grep';
    case 'edit':
    case 'write':
      return 'editing';
    case 'shell':
      return 'calling: Shell';
    default:
      if (isBrowsingTool(tool)) {
        return `browsing: ${tool}`;
      }
      if (lower.startsWith('mcp:')) {
        return `calling: ${tool}`;
      }
      return `calling: ${capitalizeToolLabel(tool)}`;
  }
}
