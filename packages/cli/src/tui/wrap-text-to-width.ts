/** 枠線・padding を除いたペイン内の有効幅（文字数ベース）。 */
export function getPaneContentWidth(options: {
  columns: number;
  paddingX?: number;
  borderWidth?: number;
}): number {
  const paddingX = options.paddingX ?? 0;
  const borderWidth = options.borderWidth ?? 0;
  return Math.max(1, options.columns - borderWidth - paddingX * 2);
}

/**
 * テキストを指定幅以内に折り返す（横方向のみ。既存の改行は維持）。
 * 単語境界（空白）を優先し、無ければ硬く分割する。
 */
export function wrapTextToWidth(text: string, width: number): string[] {
  if (width < 1) {
    return [text];
  }
  if (text === '') {
    return [''];
  }

  const lines: string[] = [];
  for (const paragraph of text.split('\n')) {
    let remaining = paragraph;
    while (remaining.length > width) {
      const breakAt = findBreakIndex(remaining, width);
      lines.push(remaining.slice(0, breakAt));
      remaining = remaining.slice(breakAt).trimStart();
    }
    lines.push(remaining);
  }
  return lines;
}

function findBreakIndex(text: string, width: number): number {
  if (text.length <= width) {
    return text.length;
  }
  const chunk = text.slice(0, width);
  const lastSpace = chunk.lastIndexOf(' ');
  if (lastSpace > 0) {
    return lastSpace;
  }
  return width;
}
