import stringWidth from 'string-width';
import type {
  InlineMarkdownLine,
  InlineMarkdownSegment,
} from '../inline-markdown.js';

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

interface StyledCharacter {
  text: string;
  width: number;
  bold?: boolean;
  code?: boolean;
  href?: string;
}

function appendStyledSegment(
  segments: InlineMarkdownSegment[],
  text: string,
  character: StyledCharacter,
): void {
  if (!text) {
    return;
  }

  const previous = segments.at(-1);
  if (
    previous &&
    Boolean(previous.bold) === Boolean(character.bold) &&
    Boolean(previous.code) === Boolean(character.code) &&
    previous.href === character.href
  ) {
    previous.text += text;
    return;
  }

  segments.push({
    text,
    ...(character.bold ? { bold: true } : {}),
    ...(character.code ? { code: true } : {}),
    ...(character.href !== undefined ? { href: character.href } : {}),
  });
}

function styledCharactersToSegments(
  characters: StyledCharacter[],
): InlineMarkdownSegment[] {
  const segments: InlineMarkdownSegment[] = [];
  for (const character of characters) {
    appendStyledSegment(segments, character.text, character);
  }
  return segments;
}

function toStyledCharacterLines(segments: InlineMarkdownSegment[]): StyledCharacter[][] {
  const lines: StyledCharacter[][] = [[]];

  for (const segment of segments) {
    for (const character of Array.from(segment.text)) {
      if (character === '\n') {
        lines.push([]);
        continue;
      }

      lines.at(-1)?.push({
        text: character,
        width: stringWidth(character),
        ...(segment.bold ? { bold: true } : {}),
        ...(segment.code ? { code: true } : {}),
        ...(segment.href !== undefined ? { href: segment.href } : {}),
      });
    }
  }

  return lines;
}

function styledCharactersWidth(characters: StyledCharacter[]): number {
  return characters.reduce((width, character) => width + character.width, 0);
}

function findStyledWrapBreakIndex(
  characters: StyledCharacter[],
  width: number,
): number {
  if (styledCharactersWidth(characters) <= width) {
    return characters.length;
  }

  let breakAt = 0;
  for (let index = 1; index <= characters.length; index++) {
    if (styledCharactersWidth(characters.slice(0, index)) <= width) {
      breakAt = index;
    } else {
      break;
    }
  }

  if (breakAt === 0) {
    return 1;
  }

  const lastSpace = characters
    .slice(0, breakAt)
    .reduce((lastIndex, character, index) => (
      character.text === ' ' ? index : lastIndex
    ), -1);
  if (
    lastSpace > 0 &&
    styledCharactersWidth(characters.slice(0, lastSpace)) <= width
  ) {
    return lastSpace;
  }
  return breakAt;
}

function trimStyledLeadingWhitespace(characters: StyledCharacter[]): void {
  while (characters[0] && characters[0].text.trim() === '') {
    characters.shift();
  }
}

function wrapStyledCharacterLine(
  characters: StyledCharacter[],
  width: number,
): InlineMarkdownLine[] {
  if (characters.length === 0) {
    return [[]];
  }

  const lines: InlineMarkdownLine[] = [];
  let remaining = characters;
  while (styledCharactersWidth(remaining) > width) {
    const breakAt = findStyledWrapBreakIndex(remaining, width);
    lines.push(styledCharactersToSegments(remaining.slice(0, breakAt)));
    remaining = remaining.slice(breakAt);
    trimStyledLeadingWhitespace(remaining);
  }
  lines.push(styledCharactersToSegments(remaining));
  return lines;
}

/**
 * スタイル付き segment 列を指定表示幅以内に折り返す。
 * セグメント境界を跨いで単語境界を探し、分割後も各行の style を維持する。
 */
export function wrapInlineMarkdownToWidth(
  segments: InlineMarkdownSegment[],
  width: number,
): InlineMarkdownLine[] {
  if (width < 1) {
    return [segments.map((segment) => ({ ...segment }))];
  }

  return toStyledCharacterLines(segments).flatMap((line) =>
    wrapStyledCharacterLine(line, width),
  );
}
