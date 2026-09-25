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

  it('keeps link display text and href in segments', () => {
    expect(parseInlineMarkdown('see [docs](https://example.com/docs)')).toEqual([
      { text: 'see ' },
      { text: 'docs', href: 'https://example.com/docs' },
    ]);
  });

  it('traverses nested inline styles inside arbitrary-depth lists', () => {
    const segments = parseInlineMarkdown(
      '- **bold** and `code` [link](https://example.com/root)\n' +
        '  1. **nested** with **`deep`** [child](https://example.com/child)\n' +
        '     - **deepest**',
    );

    expect(segments.map((segment) => segment.text).join('')).toContain(
      '- bold and code link\n  1. nested with deep child\n     - deepest',
    );
    expect(segments).toEqual(
      expect.arrayContaining([
        { text: 'bold', bold: true },
        { text: 'code', code: true },
        { text: 'link', href: 'https://example.com/root' },
        { text: 'nested', bold: true },
        { text: 'deep', bold: true, code: true },
        { text: 'child', href: 'https://example.com/child' },
        { text: 'deepest', bold: true },
      ]),
    );
  });

  it('styles inline Markdown in list item continuation lines and later items', () => {
    const input =
      '- first\n' +
      '  continuation **bold** with `code` and [link](https://example.com/link)\n' +
      '- **second**';
    const segments = parseInlineMarkdown(input);

    expect(segments.map((segment) => segment.text).join('')).toBe(
      '- first\n  continuation bold with code and link\n- second',
    );
    expect(segments).toEqual(
      expect.arrayContaining([
        { text: 'bold', bold: true },
        { text: 'code', code: true },
        { text: 'link', href: 'https://example.com/link' },
        { text: 'second', bold: true },
      ]),
    );
  });

  it('continues traversing a nested item after a list continuation line', () => {
    const input =
      '- **first**\n' +
      '  continuation **bold** with `code` and [link](https://example.com/link)\n' +
      '  - **child**';
    const segments = parseInlineMarkdown(input);

    expect(segments.map((segment) => segment.text).join('')).toBe(
      '- first\n  continuation bold with code and link\n  - child',
    );
    expect(segments).toEqual(
      expect.arrayContaining([
        { text: 'first', bold: true },
        { text: 'bold', bold: true },
        { text: 'code', code: true },
        { text: 'link', href: 'https://example.com/link' },
        { text: 'child', bold: true },
      ]),
    );
  });

  it('styles every item in loose nested lists while preserving blank lines', () => {
    const input = '- **a**\n\n  - **b**\n\n  - **c**';

    expect(parseInlineMarkdown(input)).toEqual([
      { text: '- ' },
      { text: 'a', bold: true },
      { text: '\n\n  - ' },
      { text: 'b', bold: true },
      { text: '\n\n  - ' },
      { text: 'c', bold: true },
    ]);
  });

  it('preserves the original indentation of fenced code in list items', () => {
    const input = '- **a**\n  ```\n  **raw**\n  ```';

    expect(parseInlineMarkdown(input)).toEqual([
      { text: '- ' },
      { text: 'a', bold: true },
      { text: '\n  ```\n  **raw**\n  ```' },
    ]);
  });

  it('preserves indentation while styling inline Markdown in nested tables', () => {
    const input =
      '- outer\n\n' +
      '  | **a** | `b` |\n' +
      '  | --- | --- |\n' +
      '  | c | [d](https://example.com/d) |';

    const segments = parseInlineMarkdown(input);

    expect(segments.map((segment) => segment.text).join('')).toBe(
      '- outer\n\n  | a | b |\n  | --- | --- |\n  | c | d |',
    );
    expect(segments).toEqual(
      expect.arrayContaining([
        { text: 'a', bold: true },
        { text: 'b', code: true },
        { text: 'd', href: 'https://example.com/d' },
      ]),
    );
  });

  it('traverses inline styles inside GFM table cells', () => {
    const segments = parseInlineMarkdown(
      '| **Name** | Value |\n' +
        '| --- | --- |\n' +
        '| `foo` | [bar](https://example.com/bar) |',
    );

    expect(segments.map((segment) => segment.text).join('')).toContain(
      '| Name | Value |\n| --- | --- |\n| foo | bar |',
    );
    expect(segments).toEqual(
      expect.arrayContaining([
        { text: 'Name', bold: true },
        { text: 'foo', code: true },
        { text: 'bar', href: 'https://example.com/bar' },
      ]),
    );
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
    expect(parseInlineMarkdown('*em* [link][ref] ~~del~~')).toEqual([
      { text: '*em* [link][ref] ~~del~~' },
    ]);
  });

  it('preserves reference links and autolinks verbatim', () => {
    const text = '[label][ref] and <https://example.com>';
    expect(parseInlineMarkdown(text)).toEqual([{ text }]);
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

  it('keeps Markdown inside nested list and table HTML completely literal', () => {
    expect(parseInlineMarkdown('- <span>**bold**</span>')).toEqual([
      { text: '- <span>**bold**</span>' },
    ]);
    expect(
      parseInlineMarkdown(
        '| <span>**bold**</span> | value |\n| --- | --- |\n| plain | text |',
      ),
    ).toEqual([
      {
        text: '| <span>**bold**</span> | value |\n| --- | --- |\n| plain | text |',
      },
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

  it('renders only inline link display text', () => {
    const rendered = renderInlineMarkdownToAnsi(
      'see [docs](https://example.com/docs)',
    );

    expect(rendered).toContain('see ');
    expect(rendered).toContain('docs');
    expect(rendered).not.toContain('https://example.com/docs');
    expect(rendered).not.toContain('[docs]');
  });
});
