import type { PromptModule } from '@modular-prompt/core';

/** kind ごとの agent 定義（modular-prompt 拡張）。`conductor` は暗黙起動の SDK agent、他は worker init prompt 用。 */
export interface AgentDefinition {
  /** インライン modular-prompt YAML。`promptFile` と排他。 */
  prompt?: Record<string, unknown>;
  /** プロファイルディレクトリ基準の YAML ファイル。`prompt` と排他。 */
  promptFile?: string;
}

/** プロファイル YAML の worker エントリ（文字列は name=kind のショートハンド）。 */
export type ProfileWorkerRef = string | ProfileWorkerRefObject;

export interface ProfileWorkerRefObject {
  /** セッション内の識別名（一意）。省略時は kind と同じ。 */
  name?: string;
  kind: string;
}

/** parse 後の worker 定義。 */
export interface ProfileWorkerEntry {
  name: string;
  kind: string;
}

/**
 * 作業手順・役割分担の定義。
 * agent 定義と、セッション開始時に起動する worker の一覧を返す。
 */
export interface Profile {
  /** kind 名 → agent 定義。`default` はフォールバック用。 */
  agents?: Record<string, AgentDefinition>;
  /** セッション開始時に起動する worker（name + kind）。 */
  workers: ProfileWorkerEntry[];
  /** profile 付属文書（team.md 等）。compile 時に Prepared Materials へ載せる。 */
  materials?: ProfileMaterial[];
}

export interface ProfileMaterial {
  id?: string;
  title?: string;
  /** インライン本文。`file` と排他（どちらか一方）。 */
  content?: string;
  /** `content` の代わりに、プロファイルディレクトリ基準のファイルパス。 */
  file?: string;
}

/** load 後: materials の本文が解決済み。 */
export interface ResolvedProfileMaterial {
  id: string;
  title: string;
  content: string;
}

/** load 後: agent 定義の prompt が解決済み。 */
export interface ResolvedAgentDefinition {
  prompt?: PromptModule;
}

export interface ResolvedProfile extends Omit<Profile, 'agents'> {
  agents?: Record<string, ResolvedAgentDefinition>;
}

export interface SessionWorkerSpec {
  name: string;
  kind: string;
  prompt?: PromptModule;
}

/** compile 時に state へ載せる worker 構成と kind 一覧。 */
export interface EnsembleSessionState {
  workers: Array<Pick<ProfileWorkerEntry, 'name' | 'kind'>>;
  kinds: string[];
  materials?: ResolvedProfileMaterial[];
}

export function resolvedProfileMaterials(
  materials?: ProfileMaterial[],
): ResolvedProfileMaterial[] | undefined {
  const resolved = (materials ?? []).flatMap((material, index) => {
    const content = material.content?.trim();
    if (!content) return [];

    const id = material.id ?? `material-${index + 1}`;
    const title = material.title ?? material.id ?? `Material ${index + 1}`;
    return [{ id, title, content }];
  });

  return resolved.length > 0 ? resolved : undefined;
}

export function sessionStateFromProfile(
  profile: Pick<ResolvedProfile, 'workers' | 'agents' | 'materials'>,
): EnsembleSessionState {
  return {
    workers: profile.workers.map((worker) => ({
      name: worker.name,
      kind: worker.kind,
    })),
    kinds: Object.keys(profile.agents ?? {}).sort(),
    materials: resolvedProfileMaterials(profile.materials),
  };
}

export function normalizeProfileWorker(
  entry: unknown,
  label: string,
  index: number,
): ProfileWorkerEntry {
  if (typeof entry === 'string') {
    if (!entry) {
      throw new Error(`Invalid profile worker[${index}] in ${label}: empty kind string`);
    }
    return { name: entry, kind: entry };
  }

  if (entry && typeof entry === 'object' && 'kind' in entry) {
    const worker = entry as ProfileWorkerRefObject;
    if (!worker.kind) {
      throw new Error(`Invalid profile worker[${index}] in ${label}: needs "kind"`);
    }
    return { name: worker.name ?? worker.kind, kind: worker.kind };
  }

  throw new Error(
    `Invalid profile worker[${index}] in ${label}: expected kind string or { name?, kind }`,
  );
}

export function normalizeProfileWorkers(
  workers: unknown[],
  label: string,
): ProfileWorkerEntry[] {
  const normalized = workers.map((entry, index) =>
    normalizeProfileWorker(entry, label, index),
  );

  const names = new Set<string>();
  for (const worker of normalized) {
    if (names.has(worker.name)) {
      throw new Error(
        `Invalid profile workers in ${label}: duplicate worker name "${worker.name}"`,
      );
    }
    names.add(worker.name);
  }

  return normalized;
}

export function profileWorkersToSessionSpecs(profile: ResolvedProfile): SessionWorkerSpec[] {
  return profile.workers.map((worker) => ({
    name: worker.name,
    kind: worker.kind,
    prompt: resolveAgentPromptModule(worker.kind, profile.agents),
  }));
}

/** kind に対応する profile agent module。agents[kind] → agents.default → undefined。 */
export function resolveAgentPromptModule(
  kind: string,
  agents: Record<string, ResolvedAgentDefinition> | undefined,
): PromptModule | undefined {
  const agent = agents?.[kind] ?? agents?.default;
  return agent?.prompt;
}
