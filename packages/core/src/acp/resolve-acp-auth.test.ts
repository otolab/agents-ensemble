import { describe, expect, it } from 'vitest';
import {
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

  it('uses chat-gpt for codex', () => {
    expect(resolveBuiltinAcpAuthenticateStrategy('codex')).toEqual({
      kind: 'method',
      methodId: 'chat-gpt',
    });
  });

  it('skips authenticate for claude and pi', () => {
    expect(resolveBuiltinAcpAuthenticateStrategy('claude')).toEqual({ kind: 'skip' });
    expect(resolveBuiltinAcpAuthenticateStrategy('pi')).toEqual({ kind: 'skip' });
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
