import chalk from 'chalk';
import { Lexer, type Token } from 'marked';

/** TUI と端末出力で共有する inline Markdown の表示単位。 */
export interface InlineMarkdownSegment {
  text: string;
  bold?: boolean;
  code?: boolean;
}

export type InlineMarkdownLine = InlineMarkdownSegment[];

interface InlineMarkdownStyle {
  bold: boolean;
  code: boolean;
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
    Boolean(previous.code) === style.code
  ) {
    previous.text += text;
    return;
  }

  segments.push({
    text,
    ...(style.bold ? { bold: true } : {}),
    ...(style.code ? { code: true } : {}),
  });
}

function appendTokens(
  tokens: Token[],
  style: InlineMarkdownStyle,
  segments: InlineMarkdownSegment[],
): void {
  for (const token of tokens) {
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
      case 'text':
        if (token.tokens) {
          appendTokens(token.tokens, style, segments);
        } else {
          appendSegment(segments, token.text, style);
        }
        break;
      default:
        // Phase 1 only styles strong and codespan. Preserve every other
        // token verbatim so unsupported Markdown remains backward compatible.
        appendSegment(segments, token.raw, style);
        break;
    }
  }
}

function appendBlockToken(
  token: Token,
  segments: InlineMarkdownSegment[],
): void {
  if ((token.type === 'paragraph' || token.type === 'text') && token.tokens) {
    appendTokens(token.tokens, PLAIN_STYLE, segments);

    // Paragraph tokens omit a trailing newline from their inline children,
    // while the raw token still contains it. Keep that layout whitespace.
    const consumedRawLength = token.tokens.reduce(
      (length, child) => length + child.raw.length,
      0,
    );
    appendSegment(segments, token.raw.slice(consumedRawLength), PLAIN_STYLE);
    return;
  }

  // Block-level constructs (for example fenced code) are outside the
  // Phase 1 subset and must remain exactly as they were received.
  appendSegment(segments, token.raw, PLAIN_STYLE);
}

/**
 * Inline Markdown を表示用 segment 列へ変換する。
 *
 * marked の block / inline lexer を利用するため、エスケープと inline token のネストを
 * regex 置換で再実装せずに扱える。Phase 1 外の構文は raw 表記を保持する。
 */
export function parseInlineMarkdown(text: string): InlineMarkdownSegment[] {
  if (!text) {
    return [];
  }

  try {
    const segments: InlineMarkdownSegment[] = [];
    for (const token of Lexer.lex(text)) {
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
