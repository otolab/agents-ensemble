import { describe, expect, it } from 'vitest';
import { formatWorkerDisplayName } from './worker-display-name.js';

describe('formatWorkerDisplayName', () => {
  it('omits the kind when it matches the worker name', () => {
    expect(formatWorkerDisplayName('implementer', 'implementer')).toBe('implementer');
  });

  it('includes the kind when it differs from the worker name', () => {
    expect(formatWorkerDisplayName('impl', 'implementer')).toBe('impl (implementer)');
  });
});
