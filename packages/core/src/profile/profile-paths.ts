import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { dirname } from 'node:path';

export const PROFILES_DIR = 'profiles';
export const PROFILE_FILE = 'profile.yaml';
export const TEAMS_DIR = 'teams';
export const ENSEMBLE_DIR = '.ensemble';
/** Canonical bundled default team profile name. */
export const DEFAULT_PROFILE_NAME = 'implementer-and-reviewer';
/** CLI / API alias for {@link DEFAULT_PROFILE_NAME}. */
export const DEFAULT_PROFILE_ALIAS = 'default';

/** `@agents-ensemble/core` パッケージルート（`src/profile` または `dist/profile` から算出）。 */
export function corePackageRoot(): string {
  return join(dirname(fileURLToPath(import.meta.url)), '../..');
}

/**
 * 同梱プロファイルのルート。
 * 正本はリポジトリ直下の `profiles/`。`build` で `dist/profiles/` にコピー済みなら dist を使う。
 */
export function bundledProfilesRoot(): string {
  const packageRoot = corePackageRoot();
  const distProfiles = join(packageRoot, 'dist/profiles');
  if (existsSync(join(distProfiles, DEFAULT_PROFILE_NAME, PROFILE_FILE))) {
    return distProfiles;
  }
  return join(packageRoot, '../../profiles');
}

export function bundledProfilePath(name: string): string {
  const dirName = name === DEFAULT_PROFILE_ALIAS ? DEFAULT_PROFILE_NAME : name;
  return join(bundledProfilesRoot(), dirName, PROFILE_FILE);
}

export function bundledDefaultProfilePath(): string {
  return bundledProfilePath(DEFAULT_PROFILE_NAME);
}

export function profileDirectoryPath(repoRoot: string, name: string): string {
  return join(repoRoot, PROFILES_DIR, name, PROFILE_FILE);
}
