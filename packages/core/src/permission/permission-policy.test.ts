import { describe, expect, it } from 'vitest';
import { evaluatePermissionPolicy } from './permission-policy.js';
import { parsePermissionRequest } from './permission-request.js';

describe('evaluatePermissionPolicy', () => {
  const readRequest = parsePermissionRequest({ toolName: 'Read' });
  const shellRequest = parsePermissionRequest({ toolName: 'Shell' });

  it('denies denylisted tools', () => {
    expect(
      evaluatePermissionPolicy(shellRequest, { denyTools: ['Shell'] }),
    ).toBe('deny');
  });

  it('allows allowlisted tools', () => {
    expect(
      evaluatePermissionPolicy(shellRequest, { allowTools: ['Shell'] }),
    ).toBe('allow');
  });

  it('asks for non-allowlisted tools when allowTools is set', () => {
    expect(
      evaluatePermissionPolicy(shellRequest, { allowTools: ['Read'] }),
    ).toBe('ask');
  });

  it('auto-allows read-only tools by default', () => {
    expect(evaluatePermissionPolicy(readRequest)).toBe('allow');
    expect(evaluatePermissionPolicy(shellRequest)).toBe('ask');
  });

  it('can disable read-only auto-allow', () => {
    expect(
      evaluatePermissionPolicy(readRequest, { allowReadOnlyTools: false }),
    ).toBe('ask');
  });
});
