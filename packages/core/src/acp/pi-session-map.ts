import {
  constants,
  chmodSync,
  copyFileSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
} from 'node:fs';
import { execFileSync } from 'node:child_process';
import {
  dirname,
  isAbsolute,
  join,
  relative,
  resolve,
  sep,
} from 'node:path';

const OWNER_ONLY_DIRECTORY_MODE = 0o700;
const OWNER_ONLY_FILE_MODE = 0o600;

export interface PiAcpStorageSecurityOptions {
  /** Override the host platform in filesystem-security tests. */
  platform?: NodeJS.Platform;
  /** Replace Windows ACL operations in tests. */
  applyWindowsOwnerOnlyAcl?: (paths: readonly string[]) => void;
}

const WINDOWS_OWNER_ONLY_ACL_SCRIPT = `
$ErrorActionPreference = 'Stop'
try {
  $reader = [System.IO.StreamReader]::new(
    [Console]::OpenStandardInput(),
    [System.Text.UTF8Encoding]::new($false)
  )
  $paths = $reader.ReadToEnd() | ConvertFrom-Json
  $identity = [System.Security.Principal.WindowsIdentity]::GetCurrent()
  if ($null -eq $identity -or $null -eq $identity.User) {
    throw 'Could not resolve the current Windows user SID.'
  }
  $sid = $identity.User

  foreach ($path in $paths) {
    if ([string]::IsNullOrWhiteSpace($path)) {
      throw 'A builtin Pi storage path was empty.'
    }
    $item = Get-Item -LiteralPath $path -Force -ErrorAction Stop
    if (($item.Attributes -band [System.IO.FileAttributes]::ReparsePoint) -ne 0) {
      throw 'Builtin Pi storage cannot contain a reparse point.'
    }

    $acl = Get-Acl -LiteralPath $path -ErrorAction Stop
    $acl.SetAccessRuleProtection($true, $false)
    foreach ($existingRule in @($acl.Access)) {
      [void]$acl.RemoveAccessRuleSpecific($existingRule)
    }
    $acl.SetOwner($sid)

    $inheritance = [System.Security.AccessControl.InheritanceFlags]::None
    if ($item.PSIsContainer) {
      $inheritance =
        [System.Security.AccessControl.InheritanceFlags]::ContainerInherit -bor
        [System.Security.AccessControl.InheritanceFlags]::ObjectInherit
    }
    $rule = [System.Security.AccessControl.FileSystemAccessRule]::new(
      $sid,
      [System.Security.AccessControl.FileSystemRights]::FullControl,
      $inheritance,
      [System.Security.AccessControl.PropagationFlags]::None,
      [System.Security.AccessControl.AccessControlType]::Allow
    )
    $acl.AddAccessRule($rule)
    Set-Acl -LiteralPath $path -AclObject $acl -ErrorAction Stop | Out-Null

    $actual = Get-Acl -LiteralPath $path -ErrorAction Stop
    $actualOwner = $actual.GetOwner(
      [System.Security.Principal.SecurityIdentifier]
    ).Value
    $actualRules = @(
      $actual.GetAccessRules(
        $true,
        $true,
        [System.Security.Principal.SecurityIdentifier]
      )
    )
    if (
      -not $actual.AreAccessRulesProtected -or
      $actualOwner -ne $sid.Value -or
      $actualRules.Count -ne 1 -or
      $actualRules[0].IdentityReference.Value -ne $sid.Value -or
      $actualRules[0].AccessControlType -ne
        [System.Security.AccessControl.AccessControlType]::Allow -or
      $actualRules[0].FileSystemRights -ne
        [System.Security.AccessControl.FileSystemRights]::FullControl -or
      $actualRules[0].InheritanceFlags -ne $inheritance -or
      $actualRules[0].PropagationFlags -ne
        [System.Security.AccessControl.PropagationFlags]::None -or
      $actualRules[0].IsInherited
    ) {
      throw 'Builtin Pi storage ACL verification failed.'
    }
  }
} catch {
  [Console]::Error.WriteLine($_.Exception.Message)
  exit 1
}
`;

export interface PiAcpSessionMapPaths {
  upstreamPath: string;
  /** Map path used by the earlier builtin wrapper before upstream pi-acp. */
  legacyPath: string;
  /** Previous shared worker map locations, retained for migration and reading. */
  compatibilityPaths: string[];
}

export function resolvePiAcpSessionMapPaths(
  homeDir: string,
  previousWorkerHome?: string,
): PiAcpSessionMapPaths {
  const upstreamPath = join(homeDir, '.pi', 'pi-acp', 'session-map.json');
  const legacyPath = join(homeDir, 'session-map.json');
  const compatibilityPaths = [legacyPath];
  if (previousWorkerHome) {
    compatibilityPaths.push(
      join(previousWorkerHome, '.pi', 'pi-acp', 'session-map.json'),
      join(previousWorkerHome, 'session-map.json'),
    );
  }
  return { upstreamPath, legacyPath, compatibilityPaths };
}

/** New files created by upstream Pi inherit this process umask on POSIX. */
export function setPrivatePiSessionStorageUmask(
  platform: NodeJS.Platform = process.platform,
): void {
  if (platform !== 'win32') process.umask(0o077);
}

/**
 * Prepare builtin Pi's issue-scoped storage, migrate an older shared map, and
 * restrict existing map/transcript files before upstream code opens them.
 */
export function preparePiAcpSessionStorage(input: {
  /** Shared parent that contains repository-keyed worker storage roots. */
  workerStorageParent: string;
  /** Repository-scoped root beneath workerStorageParent. */
  workerStorageRoot: string;
  workerHome: string;
  sessionsDir: string;
  legacyWorkerHome?: string;
  mapPaths: PiAcpSessionMapPaths;
}, security: PiAcpStorageSecurityOptions = {}): void {
  const platform = security.platform ?? process.platform;
  const applyWindowsOwnerOnlyAcl =
    security.applyWindowsOwnerOnlyAcl ?? setWindowsOwnerOnlyAcl;

  // Protect the shared boundary without walking unrelated repository data.
  ensureDirectory(input.workerStorageParent, platform);
  if (platform === 'win32') {
    applyWindowsOwnerOnlyAcl([input.workerStorageParent]);
  }
  ensureDirectory(input.workerStorageRoot, platform);
  ensureDirectory(input.workerHome, platform);
  ensureDirectory(input.sessionsDir, platform);
  ensureDirectory(dirname(input.mapPaths.upstreamPath), platform);

  if (platform !== 'win32') {
    secureExistingTree(input.workerStorageRoot, platform);
    if (
      input.legacyWorkerHome &&
      !isWithin(input.workerStorageRoot, input.legacyWorkerHome)
    ) {
      secureExistingTree(input.legacyWorkerHome, platform);
    }
  } else {
    secureExistingTree(
      input.workerStorageRoot,
      platform,
      applyWindowsOwnerOnlyAcl,
    );
    if (
      input.legacyWorkerHome &&
      !isWithin(input.workerStorageRoot, input.legacyWorkerHome)
    ) {
      secureExistingTree(
        input.legacyWorkerHome,
        platform,
        applyWindowsOwnerOnlyAcl,
      );
    }
  }

  migrateLegacyPiAcpSessionMap(input.mapPaths);

  secureExistingTree(
    input.workerStorageRoot,
    platform,
    applyWindowsOwnerOnlyAcl,
  );
}

/**
 * Copy the first available old map into upstream pi-acp's HOME-based location.
 * Sources remain intact so existing transcript paths and older readers work.
 */
export function migrateLegacyPiAcpSessionMap(
  paths: PiAcpSessionMapPaths,
): boolean {
  if (existsSync(paths.upstreamPath)) return false;

  const sourcePath = paths.compatibilityPaths.find(existsSync);
  if (!sourcePath) return false;

  mkdirSync(dirname(paths.upstreamPath), {
    recursive: true,
    mode: OWNER_ONLY_DIRECTORY_MODE,
  });
  try {
    copyFileSync(
      sourcePath,
      paths.upstreamPath,
      constants.COPYFILE_EXCL,
    );
    if (process.platform !== 'win32') {
      chmodSync(paths.upstreamPath, OWNER_ONLY_FILE_MODE);
    }
    return true;
  } catch (error) {
    if (
      error &&
      typeof error === 'object' &&
      'code' in error &&
      (error.code === 'EEXIST' || error.code === 'ENOENT')
    ) {
      return false;
    }
    throw error;
  }
}

function ensureDirectory(path: string, platform: NodeJS.Platform): void {
  mkdirSync(path, {
    recursive: true,
    mode: OWNER_ONLY_DIRECTORY_MODE,
  });

  const stats = lstatSync(path);
  if (stats.isSymbolicLink() || !stats.isDirectory()) {
    throw new Error(
      '[acp] builtin Pi session storage must use regular directories without symbolic links.',
    );
  }
  if (platform !== 'win32') chmodSync(path, OWNER_ONLY_DIRECTORY_MODE);
}

function secureExistingTree(
  path: string,
  platform: NodeJS.Platform,
  applyWindowsOwnerOnlyAcl: (paths: readonly string[]) => void = setWindowsOwnerOnlyAcl,
): void {
  const stats = (() => {
    try {
      return lstatSync(path);
    } catch (error) {
      if (isEnoent(error)) return undefined;
      throw error;
    }
  })();
  if (!stats) return;

  if (platform === 'win32') {
    const paths: string[] = [];
    collectExistingTree(path, paths);
    applyWindowsOwnerOnlyAcl(paths);
    return;
  }

  securePosixTree(path, stats);
}

function securePosixTree(
  path: string,
  stats: NonNullable<ReturnType<typeof lstatSync>>,
): void {
  if (stats.isSymbolicLink()) {
    throw new Error(
      '[acp] builtin Pi session storage contains a symbolic link; use regular files and directories.',
    );
  }
  if (stats.isDirectory()) {
    chmodSync(path, OWNER_ONLY_DIRECTORY_MODE);
    for (const entry of readdirSync(path, { withFileTypes: true })) {
      const childPath = join(path, entry.name);
      securePosixTree(childPath, lstatSync(childPath));
    }
    return;
  }
  if (stats.isFile()) {
    chmodSync(path, OWNER_ONLY_FILE_MODE);
    return;
  }
  throw new Error(
    '[acp] builtin Pi session storage contains an unsupported file type.',
  );
}

function collectExistingTree(path: string, paths: string[]): void {
  const stats = lstatSync(path);
  if (stats.isSymbolicLink()) {
    throw new Error(
      '[acp] builtin Pi session storage contains a symbolic link; use regular files and directories.',
    );
  }
  if (!stats.isDirectory() && !stats.isFile()) {
    throw new Error(
      '[acp] builtin Pi session storage contains an unsupported file type.',
    );
  }

  paths.push(path);
  if (!stats.isDirectory()) return;

  for (const entry of readdirSync(path, { withFileTypes: true })) {
    collectExistingTree(join(path, entry.name), paths);
  }
}

function setWindowsOwnerOnlyAcl(paths: readonly string[]): void {
  if (paths.length === 0) return;
  execFileSync(
    'powershell.exe',
    [
      '-NoLogo',
      '-NoProfile',
      '-NonInteractive',
      '-EncodedCommand',
      Buffer.from(WINDOWS_OWNER_ONLY_ACL_SCRIPT, 'utf16le').toString('base64'),
    ],
    {
      encoding: 'utf8',
      input: JSON.stringify(paths),
      maxBuffer: 16 * 1024 * 1024,
      windowsHide: true,
    },
  );
}

function isWithin(root: string, candidate: string): boolean {
  const relativePath = relative(resolve(root), resolve(candidate));
  return (
    relativePath === '' ||
    (relativePath !== '..' &&
      !relativePath.startsWith(`..${sep}`) &&
      !isAbsolute(relativePath))
  );
}

function isEnoent(error: unknown): boolean {
  return Boolean(
    error &&
      typeof error === 'object' &&
      'code' in error &&
      error.code === 'ENOENT',
  );
}
