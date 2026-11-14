import { describe, expect, it } from 'vitest';
import { formatCursorSdkFailureDiagnostic } from './cursor-sdk-diagnostics.js';

describe('formatCursorSdkFailureDiagnostic', () => {
  it('reports a safe provider error category and known code without its message', () => {
    const diagnostic = formatCursorSdkFailureDiagnostic({
      status: 'error',
      error: {
        code: '429',
        message: 'rate limit response included provider-private details',
      },
    });

    expect(diagnostic).toContain('status=error');
    expect(diagnostic).toContain('errorCode=429');
    expect(diagnostic).toContain('errorClass=rate-limit');
    expect(diagnostic).not.toContain('provider-private details');
  });

  it('omits unknown status and error code values', () => {
    const diagnostic = formatCursorSdkFailureDiagnostic({
      status: 'unexpected-status-value',
      error: {
        code: 'untrusted-provider-value',
        message: 'do not print raw provider details',
      },
    });

    expect(diagnostic).toContain('status=other');
    expect(diagnostic).toContain('errorCode=omitted');
    expect(diagnostic).toContain('errorClass=provider-error');
    expect(diagnostic).not.toContain('untrusted-provider-value');
    expect(diagnostic).not.toContain('do not print raw provider details');
  });
});
