import { describe, expect, it } from 'vitest';
import { parseMessage } from './json-rpc.js';

describe('parseMessage errors', () => {
  it('throws on empty line', () => {
    expect(() => parseMessage('')).toThrow('Empty JSON-RPC line');
  });

  it('throws on invalid JSON-RPC envelope', () => {
    expect(() => parseMessage('{"jsonrpc":"1.0","id":1}')).toThrow(
      'Invalid JSON-RPC 2.0 message',
    );
  });

  it('throws on invalid JSON', () => {
    expect(() => parseMessage('not-json')).toThrow();
  });
});
