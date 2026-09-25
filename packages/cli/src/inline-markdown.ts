import chalk from 'chalk';
import { Lexer, type Token, type Tokens } from 'marked';

/** TUI と端末出力で共有する inline Markdown の表示単位。 */
export interface InlineMarkdownSegment {
  text: string;
  bold?: boolean;
  code?: boolean;
  href?: string;
}

export type InlineMarkdownLine = InlineMarkdownSegment[];

interface InlineMarkdownStyle {
  bold: boolean;
  code: boolean;
  href?: string;
}

const PLAIN_STYLE: InlineMarkdownStyle = { bold: false, code: false };

function appendSegment(
  segments: InlineMarkdownSegment[],
  text: string,
  style: InlineMarkdownStyle,
): void {
  if (!text) {
    return;
  }

  const previous = segments.at(-1);
  if (
    previous &&
    Boolean(previous.bold) === style.bold &&
    Boolean(previous.code) === style.code &&
    previous.href === style.href
  ) {
    previous.text += text;
    return;
  }

  segments.push({
    text,
    ...(style.bold ? { bold: true } : {}),
    ...(style.code ? { code: true } : {}),
    ...(style.href !== undefined ? { href: style.href } : {}),
  });
}

function isSupportedInlineLink(token: Token): boolean {
  if (token.type !== 'link') {
    return false;
  }

  // Keep reference links, autolinks, and bare GFM URLs literal. The Phase 2
  // subset only supports the explicit `[text](url)` form.
  return /^\[[\s\S]*\]\s*\(/.test(token.raw);
}

function appendToken(
  token: Token,
  style: InlineMarkdownStyle,
  segments: InlineMarkdownSegment[],
  source?: string,
): void {
  if (
    token.type === 'list' ||
    token.type === 'list_item' ||
    token.type === 'table'
  ) {
    appendBlockToken(token, segments, source);
    return;
  }

  if ((token.type === 'paragraph' || token.type === 'text') && token.tokens) {
    appendSourceWithTokens(source ?? token.raw, token.tokens, style, segments);
    return;
  }

  appendInlineToken(token, style, segments, source);
}

function appendTokens(
  tokens: Token[],
  style: InlineMarkdownStyle,
  segments: InlineMarkdownSegment[],
): void {
  for (const token of tokens) {
    appendToken(token, style, segments);
  }
}

function appendInlineToken(
  token: Token,
  style: InlineMarkdownStyle,
  segments: InlineMarkdownSegment[],
  source?: string,
): void {
  switch (token.type) {
    case 'strong':
      if (token.tokens) {
        appendTokens(token.tokens, { ...style, bold: true }, segments);
      } else {
        appendSegment(segments, token.text, { ...style, bold: true });
      }
      break;
    case 'codespan':
      appendSegment(segments, token.text, { ...style, code: true });
      break;
    case 'escape':
      appendSegment(segments, token.text, style);
      break;
    case 'link':
      if (!isSupportedInlineLink(token)) {
        appendSegment(segments, token.raw, style);
        break;
      }
      if (token.tokens) {
        appendTokens(token.tokens, { ...style, href: token.href }, segments);
      } else {
        appendSegment(segments, token.text, { ...style, href: token.href });
      }
      break;
    case 'text':
      if (token.tokens) {
        appendSourceWithTokens(token.raw, token.tokens, style, segments);
      } else {
        appendSegment(segments, token.raw, style);
      }
      break;
    default:
      // Unsupported inline syntax remains verbatim for backward compatibility.
      appendSegment(segments, source ?? token.raw, style);
      break;
  }
}

/**
 * Append child tokens while preserving the source text between them.
 *
 * Block token children (notably list items) omit their parent's indentation,
 * and text tokens omit the newline that follows their inline children. Finding
 * each child raw value in order preserves both kinds of structural text while
 * still allowing the child token to be traversed recursively.
 */
interface SourceRange {
  start: number;
  end: number;
}

function findSourceRange(source: string, raw: string, from: number): SourceRange | undefined {
  const exactStart = source.indexOf(raw, from);
  if (exactStart >= 0) {
    return { start: exactStart, end: exactStart + raw.length };
  }

  // marked removes the common indentation from nested block token raw values.
  // Match every token line against the corresponding source line so blank
  // lines do not cause the rest of a loose list to be treated as raw text.
  const hasTrailingNewline = raw.endsWith('\n');
  const rawLines = hasTrailingNewline ? raw.slice(0, -1).split('\n') : raw.split('\n');
  const firstLine = rawLines[0]?.trimStart() ?? '';
  if (!firstLine || rawLines.length === 0) {
    return undefined;
  }

  const sourceLines: Array<{
    start: number;
    contentEnd: number;
    end: number;
    text: string;
  }> = [];
  for (let start = 0; start <= source.length;) {
    const newline = source.indexOf('\n', start);
    const contentEnd = newline >= 0 ? newline : source.length;
    sourceLines.push({
      start,
      contentEnd,
      end: newline >= 0 ? newline + 1 : source.length,
      text: source.slice(start, contentEnd),
    });
    if (newline < 0) {
      break;
    }
    start = newline + 1;
  }

  for (let firstIndex = 0; firstIndex < sourceLines.length; firstIndex += 1) {
    const firstSourceLine = sourceLines[firstIndex];
    if (firstSourceLine.start < from) {
      continue;
    }

    let matches = true;
    for (let offset = 0; offset < rawLines.length; offset += 1) {
      const sourceLine = sourceLines[firstIndex + offset];
      if (!sourceLine) {
        matches = false;
        break;
      }

      const expected = rawLines[offset]?.trimStart() ?? '';
      const content = sourceLine.text.trimStart();
      if (expected ? !content.startsWith(expected) : content !== '') {
        matches = false;
        break;
      }
    }

    if (matches) {
      const lastSourceLine = sourceLines[firstIndex + rawLines.length - 1];
      return {
        // Include the source line's indentation in the range. This keeps
        // unsupported blocks byte-for-byte identical and lets recursive
        // children receive the original layout.
        start: firstSourceLine.start,
        end: hasTrailingNewline
          ? lastSourceLine.end
          : lastSourceLine.contentEnd,
      };
    }
  }

  return undefined;
}

function appendSourceWithTokens(
  source: string,
  tokens: Token[],
  style: InlineMarkdownStyle,
  segments: InlineMarkdownSegment[],
): void {
  let cursor = 0;
  for (const token of tokens) {
    const childRange = findSourceRange(source, token.raw, cursor);
    if (!childRange) {
      // marked may normalize a token in a malformed construct. Preserve the
      // complete source rather than duplicating or inventing text.
      appendSegment(segments, source.slice(cursor), style);
      return;
    }

    appendSegment(segments, source.slice(cursor, childRange.start), style);
    appendToken(token, style, segments, source.slice(childRange.start, childRange.end));
    cursor = childRange.end;
  }
  appendSegment(segments, source.slice(cursor), style);
}

function appendTableToken(
  token: Tokens.Table,
  segments: InlineMarkdownSegment[],
  source: string = token.raw,
): void {
  let cursor = 0;
  const cells = [
    ...token.header,
    ...token.rows.flat(),
  ];

  for (const cell of cells) {
    if (!cell.text) {
      continue;
    }

    const cellStart = source.indexOf(cell.text, cursor);
    if (cellStart < 0) {
      appendSegment(segments, source.slice(cursor), PLAIN_STYLE);
      return;
    }

    appendSegment(segments, source.slice(cursor, cellStart), PLAIN_STYLE);
    appendSourceWithTokens(cell.text, cell.tokens, PLAIN_STYLE, segments);
    cursor = cellStart + cell.text.length;
  }

  appendSegment(segments, source.slice(cursor), PLAIN_STYLE);
}

function appendBlockToken(
  token: Token,
  segments: InlineMarkdownSegment[],
  source: string = token.raw,
): void {
  if (token.type === 'table') {
    appendTableToken(token as Tokens.Table, segments, source);
    return;
  }

  if (token.type === 'list') {
    appendSourceWithTokens(
      source,
      (token as Tokens.List).items,
      PLAIN_STYLE,
      segments,
    );
    return;
  }

  if (token.type === 'list_item') {
    appendSourceWithTokens(
      source,
      (token as Tokens.ListItem).tokens,
      PLAIN_STYLE,
      segments,
    );
    return;
  }

  if ((token.type === 'paragraph' || token.type === 'text') && token.tokens) {
    appendSourceWithTokens(source, token.tokens, PLAIN_STYLE, segments);
    return;
  }

  // Block-level constructs (for example fenced code) are outside the
  // Phase 1 subset and must remain exactly as they were received.
  appendSegment(segments, source, PLAIN_STYLE);
}

function containsHtmlToken(tokens: Token[]): boolean {
  for (const token of tokens) {
    if (token.type === 'html') {
      return true;
    }
    if ('tokens' in token && token.tokens && containsHtmlToken(token.tokens)) {
      return true;
    }
    if (token.type === 'list') {
      if ((token as Tokens.List).items.some((item) => containsHtmlToken(item.tokens))) {
        return true;
      }
    }
    if (token.type === 'table') {
      const table = token as Tokens.Table;
      const cells = [...table.header, ...table.rows.flat()];
      if (cells.some((cell) => containsHtmlToken(cell.tokens))) {
        return true;
      }
    }
  }
  return false;
}

/**
 * Inline Markdown を表示用 segment 列へ変換する。
 *
 * marked の block / inline lexer を利用するため、エスケープと inline token のネストを
 * regex 置換で再実装せずに扱える。対応ブロック内の構造も子 token を再帰走査し、
 * Phase 2 外の構文は raw 表記を保持する。
 */
export function parseInlineMarkdown(text: string): InlineMarkdownSegment[] {
  if (!text) {
    return [];
  }

  try {
    const segments: InlineMarkdownSegment[] = [];
    const tokens = Lexer.lex(text);
    if (containsHtmlToken(tokens)) {
      // HTML is outside Phase 1. Keeping the complete input raw also prevents
      // Markdown inside an inline HTML tag from being styled accidentally.
      return [{ text }];
    }
    for (const token of tokens) {
      appendBlockToken(token, segments);
    }
    return segments;
  } catch {
    // A malformed input must not make a logging/view path fail.
    return [{ text }];
  }
}

function renderSegmentToAnsi(segment: InlineMarkdownSegment): string {
  if (segment.bold && segment.code) {
    return chalk.bold.cyan(segment.text);
  }
  if (segment.bold) {
    return chalk.bold(segment.text);
  }
  if (segment.code) {
    return chalk.cyan(segment.text);
  }
  return segment.text;
}

/** 共通 segment 列を stderr / dialogue 向け ANSI テキストへ変換する。 */
export function renderInlineMarkdownSegmentsToAnsi(
  segments: InlineMarkdownSegment[],
): string {
  return segments.map(renderSegmentToAnsi).join('');
}

/** Inline Markdown を stderr / dialogue 向け ANSI テキストへ変換する。 */
export function renderInlineMarkdownToAnsi(text: string): string {
  return renderInlineMarkdownSegmentsToAnsi(parseInlineMarkdown(text));
}
