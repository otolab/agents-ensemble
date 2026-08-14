import { readFile } from 'node:fs/promises';
import { dirname, isAbsolute, join } from 'node:path';
import yaml from 'js-yaml';
import { parsePromptModuleFromYaml } from './parse-prompt-module.js';
import type {
  AgentDefinition,
  Profile,
  ProfileMaterial,
  ResolvedAgentDefinition,
  ResolvedProfile,
} from './types.js';
import { resolveWorkerWorkspacePath } from './resolve-worker-workspace.js';
import { normalizeProfileWorkers } from './types.js';
import { resolveTeamProfilePath } from './team-profile-resolution.js';
import {
  bundledDefaultProfilePath,
  DEFAULT_PROFILE_ALIAS,
  DEFAULT_PROFILE_NAME,
  PROFILE_FILE,
  profileDirectoryPath,
} from './profile-paths.js';

export {
  bundledDefaultProfilePath,
  bundledProfilePath,
  bundledProfilesRoot,
  corePackageRoot,
  DEFAULT_PROFILE_ALIAS,
  DEFAULT_PROFILE_NAME,
  ENSEMBLE_DIR,
  PROFILE_FILE,
  profileDirectoryPath,
  PROFILES_DIR,
  TEAMS_DIR,
} from './profile-paths.js';
export {
  teamProfileRoots,
  resolveTeamProfilePath,
  listTeamProfiles,
  normalizeTeamProfileName,
  teamProfileId,
} from './team-profile-resolution.js';

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
    const legacy = agent as Record<string, unknown>;
    if ('systemPrompt' in legacy || 'systemPromptFile' in legacy) {
      throw new Error(
        `Invalid profile agent "${name}" in ${label}: systemPrompt / systemPromptFile are removed; use prompt / promptFile`,
      );
    }
    if (agent.prompt && agent.promptFile) {
      throw new Error(
        `Invalid profile agent "${name}" in ${label}: use either prompt or promptFile`,
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
  if (!agent.prompt && !agent.promptFile) {
    return {};
  }

  if (agent.promptFile) {
    const raw = yaml.load(await readProfileFile(profileDir, agent.promptFile));
    return {
      prompt: parsePromptModuleFromYaml(raw, `${label} (${agent.promptFile})`),
    };
  }

  return {
    prompt: parsePromptModuleFromYaml(agent.prompt, `${label} (agents.${name}.prompt)`),
  };
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

function resolveProfileWorkers(
  workers: Profile['workers'],
  profileDir: string,
  repoRoot: string,
): Profile['workers'] {
  return workers.map((worker) => ({
    ...worker,
    ...(worker.workspace
      ? {
          resolvedWorkspacePath: resolveWorkerWorkspacePath(
            worker.workspace,
            profileDir,
            repoRoot,
          ),
        }
      : {}),
  }));
}

/** `file` / `promptFile` を読み込み、インラインに解決する。 */
export async function resolveProfile(
  profile: Profile,
  profileDir: string,
  repoRoot: string,
): Promise<ResolvedProfile> {
  const label = join(profileDir, PROFILE_FILE);

  const agents: Record<string, ResolvedAgentDefinition> = {};
  for (const [name, agent] of Object.entries(profile.agents ?? {})) {
    agents[name] = await resolveAgent(name, agent, profileDir, label);
  }

  return {
    workers: resolveProfileWorkers(profile.workers, profileDir, repoRoot),
    agents: Object.keys(agents).length > 0 ? agents : undefined,
    materials: await Promise.all(
      (profile.materials ?? []).map((material) =>
        resolveMaterial(material, profileDir, label),
      ),
    ),
  };
}

export async function loadProfileFromFile(
  filePath: string,
  options?: { repoRoot?: string },
): Promise<ResolvedProfile> {
  const profileDir = dirname(filePath);
  const repoRoot = options?.repoRoot ?? profileDir;
  const raw = await readFile(filePath, 'utf8');
  const parsed = yaml.load(raw);
  const profile = parseProfile(parsed, filePath);
  return resolveProfile(profile, profileDir, repoRoot);
}

/**
 * プロファイル参照をファイルパスに解決する。
 * - 名前のみ → project `.ensemble/teams/` > user `~/.ensemble/teams/` > bundled > legacy
 * - `profiles/foo/profile.yaml` や絶対パスは repoRoot 基準でそのまま
 */
export function resolveProfilePath(ref: string, repoRoot: string): string {
  return resolveTeamProfilePath(ref, { repoRoot });
}

/** --profile 未指定時は同梱 default。 */
export function resolveDefaultProfilePath(): string {
  return bundledDefaultProfilePath();
}

export async function loadProfile(options: {
  profile?: string;
  cwd?: string;
}): Promise<{ profile: ResolvedProfile; profilePath: string }> {
  const cwd = options.cwd ?? process.cwd();
  const profilePath = options.profile
    ? resolveProfilePath(options.profile, cwd)
    : resolveDefaultProfilePath();
  const profile = await loadProfileFromFile(profilePath, { repoRoot: cwd });
  return { profile, profilePath };
}
