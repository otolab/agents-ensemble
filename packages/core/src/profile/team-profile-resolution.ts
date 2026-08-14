import { existsSync, readdirSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { isAbsolute, join } from 'node:path';
import yaml from 'js-yaml';
import {
  bundledProfilePath,
  bundledProfilesRoot,
  DEFAULT_PROFILE_ALIAS,
  DEFAULT_PROFILE_NAME,
  ENSEMBLE_DIR,
  PROFILE_FILE,
  profileDirectoryPath,
  PROFILES_DIR,
  TEAMS_DIR,
} from './profile-paths.js';
import type { Profile } from './types.js';

export type TeamProfileSource = 'project' | 'user' | 'bundled' | 'legacy';

export interface TeamProfileMeta {
  id?: string;
  title?: string;
  summary?: string;
}

export interface TeamProfileListEntry {
  /** Canonical identifier, e.g. `my-team@project`. */
  id: string;
  /** Short display name (directory name or canonical bundled name). */
  name: string;
  source: TeamProfileSource;
  /** Absolute path to `profile.yaml`. */
  path: string;
  meta?: TeamProfileMeta;
  /** Worker kind or name preview for catalog display. */
  workersPreview: string[];
}

export interface TeamProfileRoot {
  source: TeamProfileSource;
  root: string;
}

export interface TeamProfileResolutionOptions {
  repoRoot: string;
  /** Override for tests. Defaults to `~/.ensemble`. */
  userEnsembleRoot?: string;
}

function userEnsembleRoot(options: TeamProfileResolutionOptions): string {
  return options.userEnsembleRoot ?? join(homedir(), ENSEMBLE_DIR);
}

function projectTeamsRoot(repoRoot: string): string {
  return join(repoRoot, ENSEMBLE_DIR, TEAMS_DIR);
}

function userTeamsRoot(options: TeamProfileResolutionOptions): string {
  return join(userEnsembleRoot(options), TEAMS_DIR);
}

function legacyProfilesRoot(repoRoot: string): string {
  return join(repoRoot, PROFILES_DIR);
}

export function normalizeTeamProfileName(name: string): string {
  if (name === DEFAULT_PROFILE_ALIAS) {
    return DEFAULT_PROFILE_NAME;
  }
  return name;
}

export function teamProfileId(name: string, source: TeamProfileSource): string {
  return `${normalizeTeamProfileName(name)}@${source}`;
}

function isPathLikeRef(ref: string): boolean {
  return (
    isAbsolute(ref) ||
    ref.endsWith('.yaml') ||
    ref.endsWith('.yml') ||
    ref.includes('/')
  );
}

function teamProfileFilePath(teamDir: string): string {
  return join(teamDir, PROFILE_FILE);
}

function listTeamDirs(root: string): string[] {
  if (!existsSync(root)) {
    return [];
  }

  return readdirSync(root, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort();
}

function bundledListName(dirName: string): string {
  if (dirName === DEFAULT_PROFILE_ALIAS) {
    return DEFAULT_PROFILE_NAME;
  }
  return dirName;
}

function resolveBundledProfilePath(name: string): string {
  return bundledProfilePath(name);
}

function resolveNamedTeamProfilePath(
  ref: string,
  options: TeamProfileResolutionOptions,
): string {
  const normalized = normalizeTeamProfileName(ref);
  const { repoRoot } = options;

  const candidates: Array<{ source: TeamProfileSource; path: string }> = [
  ];

  const projectPath = teamProfileFilePath(join(projectTeamsRoot(repoRoot), ref));
  if (existsSync(projectPath)) {
    candidates.push({ source: 'project', path: projectPath });
  }

  const userPath = teamProfileFilePath(join(userTeamsRoot(options), ref));
  if (existsSync(userPath)) {
    candidates.push({ source: 'user', path: userPath });
  }

  const bundledPath = resolveBundledProfilePath(normalized);
  if (existsSync(bundledPath)) {
    candidates.push({ source: 'bundled', path: bundledPath });
  }

  const legacyPath = profileDirectoryPath(repoRoot, ref);
  if (existsSync(legacyPath)) {
    candidates.push({ source: 'legacy', path: legacyPath });
  }

  if (candidates.length === 0) {
    return legacyPath;
  }

  return candidates[0]!.path;
}

/** Exploration roots in resolution priority order. */
export function teamProfileRoots(
  repoRoot: string,
  options?: Pick<TeamProfileResolutionOptions, 'userEnsembleRoot'>,
): TeamProfileRoot[] {
  const resolutionOptions: TeamProfileResolutionOptions = {
    repoRoot,
    userEnsembleRoot: options?.userEnsembleRoot,
  };

  return [
    { source: 'project', root: projectTeamsRoot(repoRoot) },
    { source: 'user', root: userTeamsRoot(resolutionOptions) },
    { source: 'bundled', root: bundledProfilesRoot() },
    { source: 'legacy', root: legacyProfilesRoot(repoRoot) },
  ];
}

/**
 * Resolve a team profile reference to an absolute `profile.yaml` path.
 * Name-only refs use priority: project > user > bundled > legacy.
 */
export function resolveTeamProfilePath(
  ref: string,
  options: TeamProfileResolutionOptions,
): string {
  if (isPathLikeRef(ref)) {
    return isAbsolute(ref) ? ref : join(options.repoRoot, ref);
  }

  return resolveNamedTeamProfilePath(ref, options);
}

function workerPreview(entry: unknown): string {
  if (typeof entry === 'string') {
    return entry;
  }
  if (entry && typeof entry === 'object' && 'kind' in entry) {
    const worker = entry as { name?: string; kind?: string };
    return worker.name ?? worker.kind ?? 'worker';
  }
  return 'worker';
}

async function readTeamProfileMeta(
  filePath: string,
  fallbackName: string,
): Promise<{ meta?: TeamProfileMeta; workersPreview: string[] }> {
  try {
    const raw = yaml.load(await readFile(filePath, 'utf8')) as Profile | undefined;
    const workersPreview = (raw?.workers ?? []).map(workerPreview);
    const meta = raw?.meta
      ? {
          id: raw.meta.id ?? fallbackName,
          title: raw.meta.title,
          summary: raw.meta.summary,
        }
      : {
          id: fallbackName,
          title: fallbackName,
        };

    return { meta, workersPreview };
  } catch {
    return { workersPreview: [] };
  }
}

async function listProfilesInRoot(
  source: TeamProfileSource,
  root: string,
  nameMapper?: (dirName: string) => string,
): Promise<TeamProfileListEntry[]> {
  const entries: TeamProfileListEntry[] = [];

  for (const dirName of listTeamDirs(root)) {
    const filePath = teamProfileFilePath(join(root, dirName));
    if (!existsSync(filePath)) {
      continue;
    }

    const name = nameMapper ? nameMapper(dirName) : dirName;
    const { meta, workersPreview } = await readTeamProfileMeta(filePath, name);

    entries.push({
      id: teamProfileId(name, source),
      name,
      source,
      path: filePath,
      meta,
      workersPreview,
    });
  }

  return entries;
}

/** List team profiles from all layers with source distinction. */
export async function listTeamProfiles(
  options: TeamProfileResolutionOptions,
): Promise<TeamProfileListEntry[]> {
  const { repoRoot } = options;
  const entries: TeamProfileListEntry[] = [];

  entries.push(
    ...(await listProfilesInRoot('project', projectTeamsRoot(repoRoot))),
    ...(await listProfilesInRoot('user', userTeamsRoot(options))),
    ...(await listProfilesInRoot('bundled', bundledProfilesRoot(), bundledListName)),
    ...(await listProfilesInRoot('legacy', legacyProfilesRoot(repoRoot))),
  );

  return entries;
}
