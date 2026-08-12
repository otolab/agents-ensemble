import stringWidth from 'string-width';

/** 枠線・padding を除いたペイン内の有効幅（表示幅ベース）。 */
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
 * テキストを指定表示幅以内に折り返す（横方向のみ。既存の改行は維持）。
 * 単語境界（空白）を優先し、無ければ硬く分割する。CJK は `string-width` で幅計算。
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
    while (stringWidth(remaining) > width) {
      const breakAt = findWrapBreakIndex(remaining, width);
      lines.push(remaining.slice(0, breakAt));
      remaining = remaining.slice(breakAt).trimStart();
    }
    lines.push(remaining);
  }
  return lines;
}

/** {@link wrapTextToWidth} と同じ折り返し位置を返す（テスト・カーソル計算用）。 */
export function findWrapBreakIndex(text: string, width: number): number {
  if (stringWidth(text) <= width) {
    return text.length;
  }

  let breakAt = 0;
  for (let index = 1; index <= text.length; index++) {
    if (stringWidth(text.slice(0, index)) <= width) {
      breakAt = index;
    } else {
      break;
    }
  }

  if (breakAt === 0) {
    return 1;
  }

  const chunk = text.slice(0, breakAt);
  const lastSpace = chunk.lastIndexOf(' ');
  if (lastSpace > 0 && stringWidth(chunk.slice(0, lastSpace)) <= width) {
    return lastSpace;
  }
  return breakAt;
}
