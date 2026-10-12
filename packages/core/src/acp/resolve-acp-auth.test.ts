import { describe, expect, it } from 'vitest';
import {
  parseProfileAcpAuthenticate,
  resolveAcpAuthenticateStrategy,
  resolveBuiltinAcpAuthenticateStrategy,
} from './resolve-acp-auth.js';

describe('resolveBuiltinAcpAuthenticateStrategy', () => {
  it('uses cursor_login for cursor', () => {
    expect(resolveBuiltinAcpAuthenticateStrategy('cursor')).toEqual({
      kind: 'method',
      methodId: 'cursor_login',
    });
  });

  it('skips authenticate for codex, claude, and pi', () => {
    expect(resolveBuiltinAcpAuthenticateStrategy('codex')).toEqual({ kind: 'skip' });
    expect(resolveBuiltinAcpAuthenticateStrategy('claude')).toEqual({ kind: 'skip' });
    expect(resolveBuiltinAcpAuthenticateStrategy('pi')).toEqual({ kind: 'skip' });
  });
});

describe('parseProfileAcpAuthenticate', () => {
  it('parses skip and method ids', () => {
    expect(parseProfileAcpAuthenticate('skip')).toEqual({ kind: 'skip' });
    expect(parseProfileAcpAuthenticate('chat-gpt')).toEqual({
      kind: 'method',
      methodId: 'chat-gpt',
    });
  });

  it('rejects empty strings', () => {
    expect(() => parseProfileAcpAuthenticate('   ')).toThrow(/empty string/);
  });
});

describe('resolveAcpAuthenticateStrategy', () => {
  it('maps custom agent acp to cursor_login', () => {
    expect(
      resolveAcpAuthenticateStrategy({
        preset: 'custom',
        command: '/usr/local/bin/agent',
        args: ['acp'],
      }),
    ).toEqual({ kind: 'method', methodId: 'cursor_login' });
  });

  it('skips authenticate for other custom commands', () => {
    expect(
      resolveAcpAuthenticateStrategy({
        preset: 'custom',
        command: 'codex-acp',
        args: [],
      }),
    ).toEqual({ kind: 'skip' });
  });
});
