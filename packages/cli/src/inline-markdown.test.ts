import { describe, expect, it } from 'vitest';
import {
  parseInlineMarkdown,
  renderInlineMarkdownToAnsi,
} from './inline-markdown.js';

describe('parseInlineMarkdown', () => {
  it('parses bold and inline code into shared segments', () => {
    expect(parseInlineMarkdown('run **bold** with `code`')).toEqual([
      { text: 'run ' },
      { text: 'bold', bold: true },
      { text: ' with ' },
      { text: 'code', code: true },
    ]);
  });

  it('keeps nested bold and code styles together', () => {
    expect(parseInlineMarkdown('use **`flag`** now')).toEqual([
      { text: 'use ' },
      { text: 'flag', bold: true, code: true },
      { text: ' now' },
    ]);
  });

  it('supports the double-underscore bold form', () => {
    expect(parseInlineMarkdown('__bold__')).toEqual([{ text: 'bold', bold: true }]);
  });

  it('interprets escapes as plain text', () => {
    expect(parseInlineMarkdown('\\*not bold\\* and \\`not code\\`')).toEqual([
      { text: '*not bold* and `not code`' },
    ]);
  });

  it('falls back to literal text for an unclosed code span', () => {
    expect(parseInlineMarkdown('before `unclosed')).toEqual([
      { text: 'before `unclosed' },
    ]);
  });

  it('preserves unsupported inline syntax verbatim', () => {
    expect(parseInlineMarkdown('*em* [link](url) ~~del~~')).toEqual([
      { text: '*em* [link](url) ~~del~~' },
    ]);
  });

  it('does not style fenced code blocks', () => {
    expect(parseInlineMarkdown('```\n**not bold**\n```')).toEqual([
      { text: '```\n**not bold**\n```' },
    ]);
  });

  it('keeps Markdown inside inline HTML completely literal', () => {
    expect(parseInlineMarkdown('<span>**bold**</span>')).toEqual([
      { text: '<span>**bold**</span>' },
    ]);
    expect(parseInlineMarkdown('before <span>`code`</span> after')).toEqual([
      { text: 'before <span>`code`</span> after' },
    ]);
  });
});

describe('renderInlineMarkdownToAnsi', () => {
  it('does not leak Markdown delimiters to terminal output', () => {
    const rendered = renderInlineMarkdownToAnsi('run **bold** with `code`');

    expect(rendered).not.toContain('**');
    expect(rendered).not.toContain('`');
    expect(rendered).toContain('run ');
    expect(rendered).toContain('bold');
    expect(rendered).toContain('code');
  });
});
