import { describe, expect, it } from 'vitest';
import {
  NdJsonLineBuffer,
  parseMessage,
  serializeMessage,
} from './json-rpc.js';

describe('json-rpc', () => {
  it('serializes messages with trailing newline', () => {
    const line = serializeMessage({
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: {},
    });
    expect(line.endsWith('\n')).toBe(true);
    expect(JSON.parse(line.trim())).toEqual({
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: {},
    });
  });

  it('parses a response line', () => {
    const msg = parseMessage(
      '{"jsonrpc":"2.0","id":1,"result":{"sessionId":"s1"}}',
    );
    expect(msg).toEqual({
      jsonrpc: '2.0',
      id: 1,
      result: { sessionId: 's1' },
    });
  });

  it('buffers partial lines across chunks', () => {
    const buffer = new NdJsonLineBuffer();
    expect(buffer.push('{"jsonrpc":"2.0","id":1,"result":')).toEqual([]);
    const lines = buffer.push('{}}\n');
    expect(lines).toHaveLength(1);
    expect(parseMessage(lines[0]!)).toEqual({
      jsonrpc: '2.0',
      id: 1,
      result: {},
    });
  });
});
