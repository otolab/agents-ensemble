import type { PromptModule } from '@modular-prompt/core';
import type { ConductorBackend } from '../config/types.js';
import type {
  AcpSpawnFingerprint,
  DefaultAcpResolutionOptions,
} from '../acp/resolve-acp-spawn.js';
import type { SpawnAcpProcessOptions } from '../acp/acp-process.js';
import type { AcpModelTag } from '../config/types.js';
import {
  acpSpawnFingerprint,
  resolveWorkerAcpSpawn,
  resolvedAcpSpawnToOptions,
} from '../acp/resolve-acp-spawn.js';

/** kind ごとの agent 定義（modular-prompt 拡張）。`conductor` は暗黙起動の SDK agent、他は worker init prompt 用。 */
export interface AgentDefinition {
  /** インライン modular-prompt YAML。`promptFile` と排他。 */
  prompt?: Record<string, unknown>;
  /** プロファイルディレクトリ基準の YAML ファイル。`prompt` と排他。 */
  promptFile?: string;
}

export interface ProfileConductorConfig {
  /** conductor LLM backend（`cursor` | `pi`）。 */
  backend?: ConductorBackend;
  /** built-in coding tools の有効化。省略時は有効。 */
  builtinTools?: boolean;
  /**
   * Pi backend のみ。Pi 標準の skill discovery（`DefaultResourceLoader` + `read` / `/skill:`）を使う。
   * 省略時は有効。`false` で skill 索引・system prompt への載せを行わない。
   */
  piSkills?: boolean;
}

/** プロファイル YAML の worker エントリ（文字列は name=kind のショートハンド）。 */
export type ProfileWorkerRef = string | ProfileWorkerRefObject;

export interface ProfileWorkerRefObject {
  /** セッション内の識別名（一意）。省略時は kind と同じ。 */
  name?: string;
  kind: string;
  /** ACP model tier. Defaults to `default`. */
  modelTag?: AcpModelTag;
  /**
   * その worker の ACP 起動 cwd（Issue worktree とは別概念）。
   * profile ディレクトリまたは repo-root 基準の相対パス、または絶対パス。
   */
  workspace?: string;
}

/** parse 後の worker 定義。 */
export interface ProfileWorkerEntry {
  name: string;
  kind: string;
  /** ACP model tier selected by this worker instance. */
  modelTag?: AcpModelTag;
  /** profile YAML の raw 値。 */
  workspace?: string;
  /** `loadProfile` 後に解決された絶対パス。 */
  resolvedWorkspacePath?: string;
}

/** team-profile 選択・一覧用メタデータ（[#176](https://github.com/otolab/agents-ensemble/issues/176)）。 */
export interface ProfileMeta {
  id?: string;
  title?: string;
  summary?: string;
}

/**
 * 作業手順・役割分担の定義。
 * agent 定義と、セッション開始時に起動する worker の一覧を返す。
 */
export interface Profile {
  /** 一覧・選択 UI 向けメタデータ。未指定時はディレクトリ名等でフォールバック。 */
  meta?: ProfileMeta;
  /** kind 名 → agent 定義。`default` はフォールバック用。 */
  agents?: Record<string, AgentDefinition>;
  /** conductor backend の profile 単位の明示設定。 */
  conductor?: ProfileConductorConfig;
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
  /** 同梱対象の agent kind。省略時は全 agent。 */
  kinds?: string[];
}

/** load 後: materials の本文が解決済み。 */
export interface ResolvedProfileMaterial {
  id: string;
  title: string;
  content: string;
  /** 同梱対象の agent kind。省略時は全 agent。 */
  kinds?: string[];
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
  modelTag: AcpModelTag;
  prompt?: PromptModule;
  resolvedWorkspacePath?: string;
  /** worker attach 時の ACP spawn オプション（command/args/env）。 */
  spawn?: SpawnAcpProcessOptions;
  /** resume 検証用フィンガープリント。 */
  acpFingerprint?: AcpSpawnFingerprint;
}

/** compile 時に state へ載せる worker 構成と kind 一覧。 */
export interface EnsembleSessionState {
  workers: Array<Pick<ProfileWorkerEntry, 'name' | 'kind'>>;
  kinds: string[];
  materials?: ResolvedProfileMaterial[];
}

export const PROFILE_ACP_REMOVED_ERROR =
  '"acp" is removed from team profile; use .ensemble/config.yaml acp.defaultPreset and acp.env (worker model tiers use modelTag)';

const PROFILE_MODEL_TAGS: readonly AcpModelTag[] = [
  'high',
  'default',
  'low',
  'fast',
];

export function resolvedProfileMaterials(
  materials?: ProfileMaterial[],
): ResolvedProfileMaterial[] | undefined {
  const resolved = (materials ?? []).flatMap((material, index) => {
    const content = material.content?.trim();
    if (!content) return [];

    const id = material.id ?? `material-${index + 1}`;
    const title = material.title ?? material.id ?? `Material ${index + 1}`;
    return [
      {
        id,
        title,
        content,
        ...(material.kinds !== undefined ? { kinds: [...material.kinds] } : {}),
      },
    ];
  });

  return resolved.length > 0 ? resolved : undefined;
}

/** agent kind に応じて Prepared Materials を絞り込む。`kinds` 省略は全員向け。 */
export function filterMaterialsForKind(
  materials: ResolvedProfileMaterial[] | undefined,
  kind: string,
): ResolvedProfileMaterial[] {
  return (materials ?? []).filter(
    (material) => material.kinds === undefined || material.kinds.includes(kind),
  );
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
    const worker = entry as ProfileWorkerRefObject & {
      acp?: unknown;
      modelTag?: unknown;
    };
    if (!worker.kind) {
      throw new Error(`Invalid profile worker[${index}] in ${label}: needs "kind"`);
    }
    if (worker.acp !== undefined) {
      throw new Error(
        `Invalid profile worker[${index}] in ${label}: ${PROFILE_ACP_REMOVED_ERROR}`,
      );
    }
    const modelTag =
      worker.modelTag === undefined ? 'default' : worker.modelTag;
    if (
      typeof modelTag !== 'string' ||
      !PROFILE_MODEL_TAGS.includes(modelTag as AcpModelTag)
    ) {
      throw new Error(
        `Invalid profile worker[${index}] in ${label}: "modelTag" must be one of ${PROFILE_MODEL_TAGS.join(' | ')}`,
      );
    }
    return {
      name: worker.name ?? worker.kind,
      kind: worker.kind,
      ...(worker.modelTag !== undefined
        ? { modelTag: modelTag as AcpModelTag }
        : {}),
      ...(typeof worker.workspace === 'string' && worker.workspace.length > 0
        ? { workspace: worker.workspace }
        : {}),
    };
  }

  throw new Error(
    `Invalid profile worker[${index}] in ${label}: expected kind string or { name?, kind, modelTag?, workspace? }`,
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

export function profileWorkersToSessionSpecs(
  profile: ResolvedProfile,
  options?: {
    defaultAcp?: DefaultAcpResolutionOptions;
    spawnBase?: SpawnAcpProcessOptions;
  },
): SessionWorkerSpec[] {
  return profile.workers.map((worker) => {
    const modelTag = worker.modelTag ?? 'default';
    const resolved = resolveWorkerAcpSpawn({
      defaultOptions: options?.defaultAcp,
      modelTag,
    });
    return {
      name: worker.name,
      kind: worker.kind,
      modelTag,
      prompt: resolveAgentPromptModule(worker.kind, profile.agents),
      ...(worker.resolvedWorkspacePath
        ? { resolvedWorkspacePath: worker.resolvedWorkspacePath }
        : {}),
      spawn: resolvedAcpSpawnToOptions(resolved, options?.spawnBase),
      acpFingerprint: acpSpawnFingerprint(resolved),
    };
  });
}

/** kind に対応する profile agent module。agents[kind] → agents.default → undefined。 */
export function resolveAgentPromptModule(
  kind: string,
  agents: Record<string, ResolvedAgentDefinition> | undefined,
): PromptModule | undefined {
  const agent = agents?.[kind] ?? agents?.default;
  return agent?.prompt;
}
