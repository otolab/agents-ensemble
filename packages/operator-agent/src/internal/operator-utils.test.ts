import { describe, expect, it } from 'vitest';
import {
  isEnoent,
  isEnoentError,
  isRecord,
  jsonToolResult,
  objectToolResult,
} from './operator-utils.js';

describe('operator utilities', () => {
  it('preserves the two ENOENT predicates', () => {
    const error = Object.assign(new Error('missing'), { code: 'ENOENT' });
    expect(isEnoent(error)).toBe(true);
    expect(isEnoentError(error)).toBe(true);
    expect(isEnoent({ code: 'ENOENT' })).toBe(true);
    expect(isEnoentError({ code: 'ENOENT' })).toBe(false);
    for (const value of [null, 'ENOENT', {}, { code: 'EACCES' }]) {
      expect(isEnoent(value)).toBe(false);
      expect(isEnoentError(value)).toBe(false);
    }
  });

  it('recognizes records without accepting arrays or null', () => {
    expect(isRecord({})).toBe(true);
    expect(isRecord([])).toBe(false);
    expect(isRecord(null)).toBe(false);
  });

  it('preserves object results and wraps non-object JSON results', () => {
    const object = { value: 'example' };
    const result = { content: [{ type: 'text', text: '{\n  "value": "example"\n}' }], structuredContent: object };
    expect(objectToolResult(object)).toEqual(result);
    expect(jsonToolResult(object)).toEqual(result);
    expect(objectToolResult(object).structuredContent).toBe(object);
    expect(jsonToolResult(object).structuredContent).toBe(object);
    expect(jsonToolResult([1, 2])).toEqual({
      content: [{ type: 'text', text: '[\n  1,\n  2\n]' }],
      structuredContent: { value: [1, 2] },
    });
    expect(jsonToolResult(null)).toEqual({
      content: [{ type: 'text', text: 'null' }],
      structuredContent: { value: null },
    });
    expect(jsonToolResult('text')).toEqual({
      content: [{ type: 'text', text: '"text"' }],
      structuredContent: { value: 'text' },
    });
  });
});
