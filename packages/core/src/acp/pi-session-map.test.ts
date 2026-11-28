import {
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  stat,
  writeFile,
} from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  migrateLegacyPiAcpSessionMap,
  preparePiAcpSessionStorage,
  resolvePiAcpSessionMapPaths,
} from './pi-session-map.js';

describe('Pi ACP session map paths', () => {
  let tempRoot = '';

  afterEach(async () => {
    if (tempRoot) await rm(tempRoot, { recursive: true, force: true });
    tempRoot = '';
  });

  it('copies the previous builtin map to upstream pi-acp home storage', async () => {
    tempRoot = await mkdtemp(join(tmpdir(), 'builtin-pi-map-'));
    const workerHome = join(tempRoot, 'worker');
    const paths = resolvePiAcpSessionMapPaths(workerHome);
    const sessionId = 'old-session';
    const cwd = '/tmp/old-worker';
    const transcriptPath = join(workerHome, 'sessions', `${sessionId}.jsonl`);
    const legacyContent = sessionMapContent(sessionId, cwd, transcriptPath);
    await mkdir(dirname(paths.legacyPath), { recursive: true });
    await mkdir(dirname(transcriptPath), { recursive: true });
    await writeFile(transcriptPath, transcriptHeader(sessionId, cwd));
    await writeFile(paths.legacyPath, legacyContent);

    expect(
      migrateLegacyPiAcpSessionMap(paths, { sessionId, cwd }),
    ).toBe(true);
    const copied = JSON.parse(await readFile(paths.upstreamPath, 'utf8')) as {
      sessions: Record<string, unknown>;
    };
    expect(Object.keys(copied.sessions)).toEqual([sessionId]);
    await expect(readFile(paths.legacyPath, 'utf8')).resolves.toBe(
      legacyContent,
    );
  });

  it('keeps an existing upstream map authoritative', async () => {
    tempRoot = await mkdtemp(join(tmpdir(), 'builtin-pi-map-'));
    const paths = resolvePiAcpSessionMapPaths(join(tempRoot, 'worker'));
    const legacyContent = '{"version":1,"sessions":{"legacy":{}}}\n';
    const upstreamContent = '{"version":1,"sessions":{"current":{}}}\n';
    await Promise.all([
      mkdir(dirname(paths.legacyPath), { recursive: true }),
      mkdir(dirname(paths.upstreamPath), { recursive: true }),
    ]);
    await Promise.all([
      writeFile(paths.legacyPath, legacyContent),
      writeFile(paths.upstreamPath, upstreamContent),
    ]);

    expect(migrateLegacyPiAcpSessionMap(paths)).toBe(false);
    await expect(readFile(paths.upstreamPath, 'utf8')).resolves.toBe(
      upstreamContent,
    );
  });

  it('does nothing when no legacy map exists', async () => {
    tempRoot = await mkdtemp(join(tmpdir(), 'builtin-pi-map-'));
    const paths = resolvePiAcpSessionMapPaths(join(tempRoot, 'worker'));

    expect(migrateLegacyPiAcpSessionMap(paths)).toBe(false);
  });

  // Windows applies owner ACLs through multiple PowerShell processes.
  it('copies only each requested Issue session from a shared map in parallel', async () => {
    tempRoot = await mkdtemp(join(tmpdir(), 'builtin-pi-map-'));
    const workerStorageParent = join(tempRoot, 'worker-storage');
    const workerStorageRoot = join(workerStorageParent, 'repo-key');
    const legacyWorkerHome = join(workerStorageRoot, 'implementer-old');
    const issueOneHome = join(
      workerStorageRoot,
      'issue-1',
      'implementer-new',
    );
    const issueTwoHome = join(
      workerStorageRoot,
      'issue-2',
      'implementer-new',
    );
    const legacyPaths = resolvePiAcpSessionMapPaths(legacyWorkerHome);
    const issueOnePaths = resolvePiAcpSessionMapPaths(
      issueOneHome,
      legacyWorkerHome,
    );
    const issueTwoPaths = resolvePiAcpSessionMapPaths(
      issueTwoHome,
      legacyWorkerHome,
    );
    const sessionOne = 'issue-one-session';
    const sessionTwo = 'issue-two-session';
    const cwdOne = '/tmp/issue-1';
    const cwdTwo = '/tmp/issue-2';
    const transcriptOne = join(
      legacyWorkerHome,
      'sessions',
      `${sessionOne}.jsonl`,
    );
    const transcriptTwo = join(
      legacyWorkerHome,
      'sessions',
      `${sessionTwo}.jsonl`,
    );
    const mapContents = JSON.stringify({
      version: 1,
      sessions: {
        [sessionOne]: {
          sessionId: sessionOne,
          cwd: cwdOne,
          sessionFile: transcriptOne,
        },
        [sessionTwo]: {
          sessionId: sessionTwo,
          cwd: cwdTwo,
          sessionFile: transcriptTwo,
        },
      },
    });
    await mkdir(workerStorageParent, { mode: 0o755 });
    await chmod(workerStorageParent, 0o755);
    await Promise.all([
      mkdir(dirname(legacyPaths.upstreamPath), {
        recursive: true,
        mode: 0o755,
      }),
      mkdir(dirname(transcriptOne), { recursive: true, mode: 0o755 }),
    ]);
    await Promise.all([
      writeFile(legacyPaths.upstreamPath, mapContents, { mode: 0o644 }),
      writeFile(transcriptOne, transcriptHeader(sessionOne, cwdOne), { mode: 0o644 }),
      writeFile(transcriptTwo, transcriptHeader(sessionTwo, cwdTwo), { mode: 0o644 }),
    ]);

    const [releaseOne, releaseTwo] = await Promise.all([
      preparePiAcpSessionStorage({
        workerStorageParent,
        workerStorageRoot,
        workerHome: issueOneHome,
        sessionsDir: join(issueOneHome, 'sessions'),
        legacyWorkerHome,
        mapPaths: issueOnePaths,
        resumeSession: { sessionId: sessionOne, cwd: cwdOne },
      }),
      preparePiAcpSessionStorage({
        workerStorageParent,
        workerStorageRoot,
        workerHome: issueTwoHome,
        sessionsDir: join(issueTwoHome, 'sessions'),
        legacyWorkerHome,
        mapPaths: issueTwoPaths,
        resumeSession: { sessionId: sessionTwo, cwd: cwdTwo },
      }),
    ]);

    const mapOne = JSON.parse(await readFile(issueOnePaths.upstreamPath, 'utf8')) as {
      sessions: Record<string, unknown>;
    };
    const mapTwo = JSON.parse(await readFile(issueTwoPaths.upstreamPath, 'utf8')) as {
      sessions: Record<string, unknown>;
    };
    expect(Object.keys(mapOne.sessions)).toEqual([sessionOne]);
    expect(Object.keys(mapTwo.sessions)).toEqual([sessionTwo]);
    await expect(readFile(legacyPaths.upstreamPath, 'utf8')).resolves.toBe(
      mapContents,
    );
    await expect(readFile(transcriptOne, 'utf8')).resolves.toBe(
      transcriptHeader(sessionOne, cwdOne),
    );
    await expect(readFile(transcriptTwo, 'utf8')).resolves.toBe(
      transcriptHeader(sessionTwo, cwdTwo),
    );

    if (process.platform !== 'win32') {
      for (const directory of [
        workerStorageParent,
        workerStorageRoot,
        legacyWorkerHome,
        join(legacyWorkerHome, 'sessions'),
        issueOneHome,
        join(issueOneHome, 'sessions'),
        issueTwoHome,
        join(issueTwoHome, 'sessions'),
        dirname(issueOnePaths.upstreamPath),
        dirname(issueTwoPaths.upstreamPath),
      ]) {
        expect((await stat(directory)).mode & 0o777).toBe(0o700);
      }
      for (const file of [
        legacyPaths.upstreamPath,
        issueOnePaths.upstreamPath,
        issueTwoPaths.upstreamPath,
        transcriptOne,
        transcriptTwo,
      ]) {
        expect((await stat(file)).mode & 0o777).toBe(0o600);
      }
    }
    await Promise.all([releaseOne(), releaseTwo()]);
  }, 30_000);

  it('migrates a workspace session without moving its transcript', async () => {
    tempRoot = await mkdtemp(join(tmpdir(), 'builtin-pi-workspace-map-'));
    const workerStorageParent = join(tempRoot, 'worker');
    const workerStorageRoot = join(workerStorageParent, 'repo-key');
    const legacyWorkerHome = join(workerStorageRoot, 'implementer-old');
    const workerHome = join(
      workerStorageRoot,
      'workspace',
      'named-workspace',
      'implementer-new',
    );
    const paths = resolvePiAcpSessionMapPaths(workerHome, legacyWorkerHome);
    const oldPaths = resolvePiAcpSessionMapPaths(legacyWorkerHome);
    const sessionId = 'workspace-session';
    const cwd = '/tmp/workspace';
    const transcriptPath = join(
      legacyWorkerHome,
      'sessions',
      `${sessionId}.jsonl`,
    );
    await mkdir(dirname(oldPaths.upstreamPath), { recursive: true });
    await mkdir(dirname(transcriptPath), { recursive: true });
    await writeFile(
      oldPaths.upstreamPath,
      sessionMapContent(sessionId, cwd, transcriptPath),
    );
    await writeFile(transcriptPath, transcriptHeader(sessionId, cwd));

    const release = await preparePiAcpSessionStorage({
      workerStorageParent,
      workerStorageRoot,
      workerHome,
      sessionsDir: join(workerHome, 'sessions'),
      legacyWorkerHome,
      mapPaths: paths,
      resumeSession: { sessionId, cwd },
    });
    const copied = JSON.parse(await readFile(paths.upstreamPath, 'utf8')) as {
      sessions: Record<string, { sessionFile: string }>;
    };

    expect(copied.sessions[sessionId]?.sessionFile).toBe(transcriptPath);
    await expect(readFile(transcriptPath, 'utf8')).resolves.toBe(
      transcriptHeader(sessionId, cwd),
    );
    await release();
  });

  it('rejects a concurrent adapter for the same worker home', async () => {
    tempRoot = await mkdtemp(join(tmpdir(), 'builtin-pi-map-lock-'));
    const workerStorageParent = join(tempRoot, 'worker');
    const workerStorageRoot = join(workerStorageParent, 'repo-key');
    const workerHome = join(workerStorageRoot, 'issue-42', 'implementer');
    const input = {
      workerStorageParent,
      workerStorageRoot,
      workerHome,
      sessionsDir: join(workerHome, 'sessions'),
      mapPaths: resolvePiAcpSessionMapPaths(workerHome),
    };
    const release = await preparePiAcpSessionStorage(input);

    await expect(preparePiAcpSessionStorage(input)).rejects.toMatchObject({
      code: 'ELOCKED',
    });
    await release();
  });

  it('does not migrate an entry whose cwd differs from the saved session', async () => {
    tempRoot = await mkdtemp(join(tmpdir(), 'builtin-pi-map-identity-'));
    const workerStorageParent = join(tempRoot, 'worker');
    const workerStorageRoot = join(workerStorageParent, 'repo-key');
    const legacyWorkerHome = join(workerStorageRoot, 'implementer-old');
    const workerHome = join(workerStorageRoot, 'issue-42', 'implementer');
    const legacyPaths = resolvePiAcpSessionMapPaths(legacyWorkerHome);
    const paths = resolvePiAcpSessionMapPaths(workerHome, legacyWorkerHome);
    const sessionId = 'saved-session';
    const transcriptPath = join(
      legacyWorkerHome,
      'sessions',
      `${sessionId}.jsonl`,
    );
    await mkdir(dirname(legacyPaths.upstreamPath), { recursive: true });
    await mkdir(dirname(transcriptPath), { recursive: true });
    await writeFile(
      legacyPaths.upstreamPath,
      sessionMapContent(sessionId, '/tmp/other-cwd', transcriptPath),
    );
    await writeFile(
      transcriptPath,
      transcriptHeader(sessionId, '/tmp/other-cwd'),
    );

    await expect(
      preparePiAcpSessionStorage({
        workerStorageParent,
        workerStorageRoot,
        workerHome,
        sessionsDir: join(workerHome, 'sessions'),
        legacyWorkerHome,
        mapPaths: paths,
        resumeSession: { sessionId, cwd: '/tmp/expected-cwd' },
      }),
    ).rejects.toThrow(/matching identity/);
    await expect(readFile(paths.upstreamPath, 'utf8')).rejects.toMatchObject({
      code: 'ENOENT',
    });
  });

  it('fails closed on a conflicting current map and preserves the old source', async () => {
    tempRoot = await mkdtemp(join(tmpdir(), 'builtin-pi-map-conflict-'));
    const workerStorageParent = join(tempRoot, 'worker');
    const workerStorageRoot = join(workerStorageParent, 'repo-key');
    const legacyWorkerHome = join(workerStorageRoot, 'legacy-worker');
    const workerHome = join(workerStorageRoot, 'issue-42', 'worker');
    const legacyPaths = resolvePiAcpSessionMapPaths(legacyWorkerHome);
    const paths = resolvePiAcpSessionMapPaths(workerHome, legacyWorkerHome);
    const sessionId = 'saved-session';
    const cwd = '/tmp/issue-42';
    const transcriptPath = join(
      legacyWorkerHome,
      'sessions',
      `${sessionId}.jsonl`,
    );
    const oldMap = sessionMapContent(sessionId, cwd, transcriptPath);
    const conflictingMap = '{"version":1,"sessions":{"different":{}}}\n';
    await Promise.all([
      mkdir(dirname(legacyPaths.upstreamPath), { recursive: true }),
      mkdir(dirname(paths.upstreamPath), { recursive: true }),
      mkdir(dirname(transcriptPath), { recursive: true }),
    ]);
    await Promise.all([
      writeFile(legacyPaths.upstreamPath, oldMap),
      writeFile(paths.upstreamPath, conflictingMap),
      writeFile(transcriptPath, transcriptHeader(sessionId, cwd)),
    ]);

    await expect(
      preparePiAcpSessionStorage({
        workerStorageParent,
        workerStorageRoot,
        workerHome,
        sessionsDir: join(workerHome, 'sessions'),
        legacyWorkerHome,
        mapPaths: paths,
        resumeSession: { sessionId, cwd },
      }),
    ).rejects.toThrow(/matching identity/);

    await expect(readFile(paths.upstreamPath, 'utf8')).resolves.toBe(
      conflictingMap,
    );
    await expect(readFile(legacyPaths.upstreamPath, 'utf8')).resolves.toBe(
      oldMap,
    );
    await expect(readFile(transcriptPath, 'utf8')).resolves.toBe(
      transcriptHeader(sessionId, cwd),
    );
  });

  it('does not publish a map when the legacy transcript is incomplete and allows retry', async () => {
    tempRoot = await mkdtemp(join(tmpdir(), 'builtin-pi-map-retry-'));
    const workerStorageParent = join(tempRoot, 'worker');
    const workerStorageRoot = join(workerStorageParent, 'repo-key');
    const legacyWorkerHome = join(workerStorageRoot, 'legacy-worker');
    const workerHome = join(workerStorageRoot, 'issue-42', 'worker');
    const legacyPaths = resolvePiAcpSessionMapPaths(legacyWorkerHome);
    const paths = resolvePiAcpSessionMapPaths(workerHome, legacyWorkerHome);
    const sessionId = 'saved-session';
    const cwd = '/tmp/issue-42';
    const transcriptPath = join(
      legacyWorkerHome,
      'sessions',
      `${sessionId}.jsonl`,
    );
    const oldMap = sessionMapContent(sessionId, cwd, transcriptPath);
    await mkdir(dirname(legacyPaths.upstreamPath), { recursive: true });
    await writeFile(legacyPaths.upstreamPath, oldMap);

    expect(
      migrateLegacyPiAcpSessionMap(paths, { sessionId, cwd }),
    ).toBe(false);
    await expect(readFile(paths.upstreamPath, 'utf8')).rejects.toMatchObject({
      code: 'ENOENT',
    });
    await expect(readFile(legacyPaths.upstreamPath, 'utf8')).resolves.toBe(
      oldMap,
    );

    await mkdir(dirname(transcriptPath), { recursive: true });
    await writeFile(transcriptPath, transcriptHeader(sessionId, cwd));
    expect(
      migrateLegacyPiAcpSessionMap(paths, { sessionId, cwd }),
    ).toBe(true);
    await expect(readFile(paths.upstreamPath, 'utf8')).resolves.toContain(
      sessionId,
    );
  });

  it('does not replace a new Issue map with the legacy shared map', async () => {
    tempRoot = await mkdtemp(join(tmpdir(), 'builtin-pi-map-'));
    const workerStorageRoot = join(tempRoot, 'worker-root');
    const legacyWorkerHome = join(workerStorageRoot, 'legacy-worker');
    const workerHome = join(workerStorageRoot, 'issue-7', 'worker');
    const legacyPaths = resolvePiAcpSessionMapPaths(legacyWorkerHome);
    const issuePaths = resolvePiAcpSessionMapPaths(
      workerHome,
      legacyWorkerHome,
    );
    const oldMap = '{"version":1,"sessions":{"old":{}}}\n';
    const currentMap = '{"version":1,"sessions":{"new":{}}}\n';
    await Promise.all([
      mkdir(dirname(legacyPaths.upstreamPath), { recursive: true }),
      mkdir(dirname(issuePaths.upstreamPath), { recursive: true }),
    ]);
    await Promise.all([
      writeFile(legacyPaths.upstreamPath, oldMap),
      writeFile(issuePaths.upstreamPath, currentMap),
    ]);

    expect(
      migrateLegacyPiAcpSessionMap(issuePaths, {
        sessionId: 'new',
        cwd: '/tmp/new',
      }),
    ).toBe(false);
    await expect(readFile(issuePaths.upstreamPath, 'utf8')).resolves.toBe(
      currentMap,
    );
  });

  it('applies the Windows owner ACL before migrating a shared map', async () => {
    tempRoot = await mkdtemp(join(tmpdir(), 'builtin-pi-acl-'));
    const workerStorageParent = join(tempRoot, 'worker');
    const workerStorageRoot = join(workerStorageParent, 'repo-key');
    const legacyWorkerHome = join(workerStorageRoot, 'implementer-old');
    const workerHome = join(workerStorageRoot, 'issue-42', 'implementer');
    const legacyPaths = resolvePiAcpSessionMapPaths(legacyWorkerHome);
    const issuePaths = resolvePiAcpSessionMapPaths(
      workerHome,
      legacyWorkerHome,
    );
    const sessionId = 'old-session';
    const cwd = '/tmp/issue-42';
    const transcriptPath = join(
      legacyWorkerHome,
      'sessions',
      `${sessionId}.jsonl`,
    );
    const mapContents = sessionMapContent(sessionId, cwd, transcriptPath);
    await mkdir(dirname(legacyPaths.upstreamPath), { recursive: true });
    await mkdir(dirname(transcriptPath), { recursive: true });
    await writeFile(transcriptPath, transcriptHeader(sessionId, cwd));
    await writeFile(legacyPaths.upstreamPath, mapContents);

    const aclCalls: string[][] = [];
    const release = await preparePiAcpSessionStorage(
      {
        workerStorageParent,
        workerStorageRoot,
        workerHome,
        sessionsDir: join(workerHome, 'sessions'),
        legacyWorkerHome,
        mapPaths: issuePaths,
        resumeSession: { sessionId, cwd },
      },
      {
        platform: 'win32',
        applyWindowsOwnerOnlyAcl: (paths) => {
          aclCalls.push([...paths]);
        },
      },
    );

    expect(aclCalls[0]).toEqual([workerStorageParent]);
    expect(aclCalls[1]).toContain(workerStorageRoot);
    expect(aclCalls[1]).toContain(legacyPaths.upstreamPath);
    expect(aclCalls.at(-1)).toContain(issuePaths.upstreamPath);
    const copied = JSON.parse(await readFile(issuePaths.upstreamPath, 'utf8')) as {
      sessions: Record<string, unknown>;
    };
    expect(Object.keys(copied.sessions)).toEqual([sessionId]);
    await release();
  });

  it('fails closed when Windows ACL setup fails', async () => {
    tempRoot = await mkdtemp(join(tmpdir(), 'builtin-pi-acl-'));
    const workerStorageParent = join(tempRoot, 'worker');
    const workerStorageRoot = join(workerStorageParent, 'repo-key');
    const workerHome = join(workerStorageRoot, 'issue-42', 'implementer');
    const issuePaths = resolvePiAcpSessionMapPaths(workerHome);

    await expect(
      preparePiAcpSessionStorage(
        {
          workerStorageParent,
          workerStorageRoot,
          workerHome,
          sessionsDir: join(workerHome, 'sessions'),
          mapPaths: issuePaths,
        },
        {
          platform: 'win32',
          applyWindowsOwnerOnlyAcl: () => {
            throw new Error('Windows ACL setup failed');
          },
        },
      ),
    ).rejects.toThrow('Windows ACL setup failed');
    await expect(readFile(issuePaths.upstreamPath, 'utf8')).rejects.toMatchObject(
      { code: 'ENOENT' },
    );
  });

  it.skipIf(process.platform !== 'win32')(
    'restricts existing storage and new upstream files to the current Windows account',
    async () => {
      tempRoot = await mkdtemp(join(tmpdir(), 'builtin-pi-acl-'));
      const workerStorageParent = join(tempRoot, 'worker');
      const workerStorageRoot = join(workerStorageParent, 'repo-key');
      const workerHome = join(
        workerStorageRoot,
        'issue-42',
        'implementer',
      );
      const mapPaths = resolvePiAcpSessionMapPaths(workerHome);
      await mkdir(dirname(mapPaths.upstreamPath), { recursive: true });
      await writeFile(mapPaths.upstreamPath, '{"sessions":{}}\n');

      const release = await preparePiAcpSessionStorage({
        workerStorageParent,
        workerStorageRoot,
        workerHome,
        sessionsDir: join(workerHome, 'sessions'),
        mapPaths,
      });

      const transcriptDirectory = join(
        workerHome,
        'sessions',
        'upstream-created',
      );
      const transcriptPath = join(
        transcriptDirectory,
        'new-session.jsonl',
      );
      await mkdir(transcriptDirectory, { recursive: true });
      await writeFile(transcriptPath, '{"type":"session"}\n');

      verifyWindowsInheritedOwnerOnlyAcl([
        transcriptDirectory,
        transcriptPath,
      ]);
      await release();
    },
  );
});

function verifyWindowsInheritedOwnerOnlyAcl(paths: string[]): void {
  const script = `
$ErrorActionPreference = 'Stop'
try {
  $reader = [System.IO.StreamReader]::new(
    [Console]::OpenStandardInput(),
    [System.Text.UTF8Encoding]::new($false)
  )
  $paths = $reader.ReadToEnd() | ConvertFrom-Json
  $sid = [System.Security.Principal.WindowsIdentity]::GetCurrent().User
  foreach ($path in $paths) {
    $item = Get-Item -LiteralPath $path -Force -ErrorAction Stop
    $acl = $item.GetAccessControl()
    $rules = @(
      $acl.GetAccessRules(
        $true,
        $true,
        [System.Security.Principal.SecurityIdentifier]
      )
    )
    $inheritance = [System.Security.AccessControl.InheritanceFlags]::None
    if ($item.PSIsContainer) {
      $inheritance =
        [System.Security.AccessControl.InheritanceFlags]::ContainerInherit -bor
        [System.Security.AccessControl.InheritanceFlags]::ObjectInherit
    }
    if (
      $acl.AreAccessRulesProtected -or
      $rules.Count -ne 1 -or
      $rules[0].IdentityReference.Value -ne $sid.Value -or
      $rules[0].AccessControlType -ne
        [System.Security.AccessControl.AccessControlType]::Allow -or
      $rules[0].FileSystemRights -ne
        [System.Security.AccessControl.FileSystemRights]::FullControl -or
      $rules[0].InheritanceFlags -ne $inheritance -or
      -not $rules[0].IsInherited
    ) {
      throw (
        "New builtin Pi data at '$path' did not inherit the account-only DACL. " +
        "Owner=$($acl.GetOwner([System.Security.Principal.SecurityIdentifier]).Value); " +
        "Protected=$($acl.AreAccessRulesProtected); Rules=$($rules | Out-String)"
      )
    }
  }
} catch {
  [Console]::Error.WriteLine($_.Exception.Message)
  exit 1
}
`;

  execFileSync(
    'powershell.exe',
    [
      '-NoLogo',
      '-NoProfile',
      '-NonInteractive',
      '-EncodedCommand',
      Buffer.from(script, 'utf16le').toString('base64'),
    ],
    {
      encoding: 'utf8',
      input: JSON.stringify(paths),
      windowsHide: true,
    },
  );
}

function sessionMapContent(
  sessionId: string,
  cwd: string,
  sessionFile: string,
): string {
  return `${JSON.stringify({
    version: 1,
    sessions: {
      [sessionId]: { sessionId, cwd, sessionFile },
    },
  })}\n`;
}

function transcriptHeader(sessionId: string, cwd: string): string {
  return `${JSON.stringify({
    type: 'session',
    version: 3,
    id: sessionId,
    cwd,
  })}\n`;
}
