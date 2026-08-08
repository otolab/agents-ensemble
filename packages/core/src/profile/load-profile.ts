import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { dirname, isAbsolute, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import yaml from 'js-yaml';
import type {
  AgentDefinition,
  Profile,
  ProfileMaterial,
  ResolvedAgentDefinition,
} from './types.js';
import { normalizeProfileWorkers } from './types.js';

export const PROFILES_DIR = 'profiles';
export const PROFILE_FILE = 'profile.yaml';
export const DEFAULT_PROFILE_NAME = 'default';

export function parseProfile(source: unknown, label: string): Profile {
  if (!source || typeof source !== 'object' || !Array.isArray((source as Profile).workers)) {
    throw new Error(`Invalid profile: ${label} (expected YAML with "workers" array)`);
  }

  const raw = source as { workers: unknown[] } & Omit<Profile, 'workers'>;
  const workers = normalizeProfileWorkers(raw.workers, label);

  const profile: Profile = { ...raw, workers };

  for (const [name, agent] of Object.entries(profile.agents ?? {})) {
    if (!agent || typeof agent !== 'object') {
      throw new Error(`Invalid profile agent "${name}" in ${label}`);
    }
    if (agent.systemPrompt && agent.systemPromptFile) {
      throw new Error(
        `Invalid profile agent "${name}" in ${label}: use either systemPrompt or systemPromptFile`,
      );
    }
  }

  for (const [index, material] of (profile.materials ?? []).entries()) {
    if (!material.content && !material.file) {
      throw new Error(
        `Invalid profile material[${index}] in ${label}: needs "content" or "file"`,
      );
    }
    if (material.content && material.file) {
      throw new Error(
        `Invalid profile material[${index}] in ${label}: use either content or file`,
      );
    }
  }

  return profile;
}

export function resolveProfileFilePath(profileDir: string, fileRef: string): string {
  if (isAbsolute(fileRef)) {
    return fileRef;
  }
  return join(profileDir, fileRef);
}

async function readProfileFile(profileDir: string, fileRef: string): Promise<string> {
  const path = resolveProfileFilePath(profileDir, fileRef);
  return readFile(path, 'utf8');
}

async function resolveAgent(
  name: string,
  agent: AgentDefinition,
  profileDir: string,
  label: string,
): Promise<ResolvedAgentDefinition> {
  if (!agent.systemPromptFile) {
    return { systemPrompt: agent.systemPrompt };
  }

  const systemPrompt = await readProfileFile(profileDir, agent.systemPromptFile);
  return { systemPrompt };
}

async function resolveMaterial(
  material: ProfileMaterial,
  profileDir: string,
  label: string,
): Promise<ProfileMaterial & { content: string }> {
  const content =
    material.content ??
    (material.file
      ? await readProfileFile(profileDir, material.file)
      : (() => {
          throw new Error(`Invalid profile material in ${label}`);
        })());

  return {
    id: material.id,
    title: material.title,
    content,
  };
}

/** `file` / `systemPromptFile` を読み込み、インラインに解決する。 */
export async function resolveProfile(
  profile: Profile,
  profileDir: string,
): Promise<Profile> {
  const label = join(profileDir, PROFILE_FILE);

  const agents: Record<string, ResolvedAgentDefinition> = {};
  for (const [name, agent] of Object.entries(profile.agents ?? {})) {
    agents[name] = await resolveAgent(name, agent, profileDir, label);
  }

  return {
    workers: profile.workers,
    agents: Object.keys(agents).length > 0 ? agents : undefined,
    materials: await Promise.all(
      (profile.materials ?? []).map((material) =>
        resolveMaterial(material, profileDir, label),
      ),
    ),
  };
}

export async function loadProfileFromFile(filePath: string): Promise<Profile> {
  const raw = await readFile(filePath, 'utf8');
  const parsed = yaml.load(raw);
  const profile = parseProfile(parsed, filePath);
  return resolveProfile(profile, dirname(filePath));
}

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
  return join(bundledProfilesRoot(), name, PROFILE_FILE);
}

export function bundledDefaultProfilePath(): string {
  return bundledProfilePath(DEFAULT_PROFILE_NAME);
}

export function profileDirectoryPath(cwd: string, name: string): string {
  return join(cwd, PROFILES_DIR, name, PROFILE_FILE);
}

/**
 * プロファイル参照をファイルパスに解決する。
 * - `default` などの名前 → 同梱 `profiles/<name>/profile.yaml`（無ければ `<cwd>/profiles/<name>/profile.yaml`）
 * - `profiles/foo/profile.yaml` や絶対パスは cwd 基準でそのまま
 */
export function resolveProfilePath(ref: string, cwd: string): string {
  if (isAbsolute(ref)) {
    return ref;
  }
  if (ref.endsWith('.yaml') || ref.endsWith('.yml') || ref.includes('/')) {
    return join(cwd, ref);
  }

  const bundled = bundledProfilePath(ref);
  if (existsSync(bundled)) {
    return bundled;
  }

  return profileDirectoryPath(cwd, ref);
}

/** --profile 未指定時は同梱 default。 */
export function resolveDefaultProfilePath(): string {
  return bundledDefaultProfilePath();
}

export async function loadProfile(options: {
  profile?: string;
  cwd?: string;
}): Promise<{ profile: Profile; profilePath: string }> {
  const cwd = options.cwd ?? process.cwd();
  const profilePath = options.profile
    ? resolveProfilePath(options.profile, cwd)
    : resolveDefaultProfilePath();
  const profile = await loadProfileFromFile(profilePath);
  return { profile, profilePath };
}
