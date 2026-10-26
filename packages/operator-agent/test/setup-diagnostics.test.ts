import { describe, expect, it } from 'vitest';
import {
  createTestDirectories,
  environmentFailure,
  withProbeCleanup,
} from './setup-diagnostics.js';

describe('operator-agent test setup diagnostics', () => {
  it.each([
    ['scratch root', '/repo/.tmp/operator-agent-vitest'],
    ['user root', '/repo/.tmp/operator-agent-vitest/user-123'],
  ])('diagnoses denied mkdir for the %s path', async (_label, deniedPath) => {
    const scratchRoot = '/repo/.tmp/operator-agent-vitest';
    const userRoot = `${scratchRoot}/user-123`;
    const calls: string[] = [];
    const createDirectory = async (path: string) => {
      calls.push(path);
      if (path === deniedPath) {
        throw Object.assign(new Error('permission denied'), { code: 'EACCES' });
      }
    };

    const failure = await createTestDirectories(
      scratchRoot,
      userRoot,
      '/tmp/operator-tests',
      createDirectory,
    ).catch((error: unknown) => error);

    expect(failure).toBeInstanceOf(Error);
    const message = (failure as Error).message;
    expect(message).toContain(
      `workspace scratch filesystem at ${deniedPath} (EACCES)`,
    );
    expect(message).toContain('TMPDIR=/tmp/operator-tests');
    expect(message).toContain(`ENSEMBLE_USER_ROOT=${userRoot}`);

    expect(calls).toEqual(
      deniedPath === scratchRoot ? [scratchRoot] : [scratchRoot, userRoot],
    );
  });

  it('preserves a diagnosed probe failure when removing its directory also fails', async () => {
    const diagnosedFailure = environmentFailure(
      'workspace scratch filesystem',
      Object.assign(new Error('permission denied'), { code: 'EPERM' }),
      '/repo/.tmp/operator-agent-vitest/oa-fs-123/probe',
      '/tmp/operator-tests',
      '/repo/.tmp/operator-agent-vitest/user-123',
    );

    await expect(
      withProbeCleanup(
        async () => {
          throw diagnosedFailure;
        },
        async () => {
          throw new Error('cleanup failed');
        },
        (error) =>
          environmentFailure(
            'workspace scratch filesystem',
            error,
            '/repo/.tmp/operator-agent-vitest/oa-fs-123',
            '/tmp/operator-tests',
            '/repo/.tmp/operator-agent-vitest/user-123',
          ),
      ),
    ).rejects.toBe(diagnosedFailure);
  });

  it('diagnoses cleanup failure after a successful probe', async () => {
    await expect(
      withProbeCleanup(
        async () => undefined,
        async () => {
          throw Object.assign(new Error('permission denied'), {
            code: 'EPERM',
          });
        },
        (error) =>
          environmentFailure(
            'workspace scratch filesystem',
            error,
            '/repo/.tmp/operator-agent-vitest/oa-fs-123',
            '/tmp/operator-tests',
            '/repo/.tmp/operator-agent-vitest/user-123',
          ),
      ),
    ).rejects.toThrow(
      'operator-agent tests cannot use the workspace scratch filesystem at /repo/.tmp/operator-agent-vitest/oa-fs-123 (EPERM)',
    );
  });
});
