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
    const paths = resolvePiAcpSessionMapPaths(join(tempRoot, 'worker'));
    const legacyContent = '{"version":1,"sessions":{"old-session":{}}}\n';
    await mkdir(dirname(paths.legacyPath), { recursive: true });
    await writeFile(paths.legacyPath, legacyContent);

    expect(migrateLegacyPiAcpSessionMap(paths)).toBe(true);
    await expect(readFile(paths.upstreamPath, 'utf8')).resolves.toBe(
      legacyContent,
    );
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

  it('copies the old shared map for each Issue while preserving old session paths', async () => {
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
    const transcriptPath = join(
      legacyWorkerHome,
      'sessions',
      'existing-session.jsonl',
    );
    const mapContents =
      '{"version":1,"sessions":{"existing-session":{"sessionId":"existing-session","cwd":"/tmp/issue-1","sessionFile":"' +
      transcriptPath +
      '"}}}\n';
    await mkdir(workerStorageParent, { mode: 0o755 });
    await chmod(workerStorageParent, 0o755);
    await Promise.all([
      mkdir(dirname(legacyPaths.upstreamPath), {
        recursive: true,
        mode: 0o755,
      }),
      mkdir(dirname(transcriptPath), { recursive: true, mode: 0o755 }),
    ]);
    await Promise.all([
      writeFile(legacyPaths.upstreamPath, mapContents, { mode: 0o644 }),
      writeFile(transcriptPath, 'existing transcript', { mode: 0o644 }),
    ]);

    preparePiAcpSessionStorage({
      workerStorageParent,
      workerStorageRoot,
      workerHome: issueOneHome,
      sessionsDir: join(issueOneHome, 'sessions'),
      legacyWorkerHome,
      mapPaths: issueOnePaths,
    });
    preparePiAcpSessionStorage({
      workerStorageParent,
      workerStorageRoot,
      workerHome: issueTwoHome,
      sessionsDir: join(issueTwoHome, 'sessions'),
      legacyWorkerHome,
      mapPaths: issueTwoPaths,
    });

    await expect(readFile(issueOnePaths.upstreamPath, 'utf8')).resolves.toBe(
      mapContents,
    );
    await expect(readFile(issueTwoPaths.upstreamPath, 'utf8')).resolves.toBe(
      mapContents,
    );
    await expect(readFile(legacyPaths.upstreamPath, 'utf8')).resolves.toBe(
      mapContents,
    );
    await expect(readFile(transcriptPath, 'utf8')).resolves.toBe(
      'existing transcript',
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
        transcriptPath,
      ]) {
        expect((await stat(file)).mode & 0o777).toBe(0o600);
      }
    }
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

    expect(migrateLegacyPiAcpSessionMap(issuePaths)).toBe(false);
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
    const mapContents = '{"version":1,"sessions":{"old-session":{}}}\n';
    await mkdir(dirname(legacyPaths.upstreamPath), { recursive: true });
    await writeFile(legacyPaths.upstreamPath, mapContents);

    const aclCalls: string[][] = [];
    preparePiAcpSessionStorage(
      {
        workerStorageParent,
        workerStorageRoot,
        workerHome,
        sessionsDir: join(workerHome, 'sessions'),
        legacyWorkerHome,
        mapPaths: issuePaths,
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
    await expect(readFile(issuePaths.upstreamPath, 'utf8')).resolves.toBe(
      mapContents,
    );
  });

  it('fails closed when Windows ACL setup fails', async () => {
    tempRoot = await mkdtemp(join(tmpdir(), 'builtin-pi-acl-'));
    const workerStorageParent = join(tempRoot, 'worker');
    const workerStorageRoot = join(workerStorageParent, 'repo-key');
    const workerHome = join(workerStorageRoot, 'issue-42', 'implementer');
    const issuePaths = resolvePiAcpSessionMapPaths(workerHome);

    expect(() =>
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
    ).toThrow('Windows ACL setup failed');
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

      preparePiAcpSessionStorage({
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
      $acl.GetOwner([System.Security.Principal.SecurityIdentifier]).Value -ne $sid.Value -or
      $rules.Count -ne 1 -or
      $rules[0].IdentityReference.Value -ne $sid.Value -or
      $rules[0].AccessControlType -ne
        [System.Security.AccessControl.AccessControlType]::Allow -or
      $rules[0].FileSystemRights -ne
        [System.Security.AccessControl.FileSystemRights]::FullControl -or
      $rules[0].InheritanceFlags -ne $inheritance -or
      -not $rules[0].IsInherited
    ) {
      throw 'New builtin Pi data did not inherit the owner-only ACL.'
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
