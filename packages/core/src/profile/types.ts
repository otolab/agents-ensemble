/** kind ごとの agent 定義（system prompt）。未指定時はコード内デフォルトにフォールバック。 */
export interface AgentDefinition {
  systemPrompt?: string;
  /** プロファイルディレクトリ基準のファイルパス。`systemPrompt` と排他。 */
  systemPromptFile?: string;
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
  /** conductor の PromptModule materials に載せる文書。 */
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

/** load 後: agent 定義の systemPrompt が解決済み。 */
export interface ResolvedAgentDefinition {
  systemPrompt?: string;
}

export interface ResolvedProfile extends Profile {
  agents?: Record<string, ResolvedAgentDefinition>;
}

export interface SessionWorkerSpec {
  name: string;
  kind: string;
  systemPrompt: string;
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

export function profileWorkersToSessionSpecs(profile: Profile): SessionWorkerSpec[] {
  return profile.workers.map((worker) => ({
    name: worker.name,
    kind: worker.kind,
    systemPrompt: resolveAgentSystemPrompt(worker.kind, profile.agents),
  }));
}

/** kind に対応する system prompt。agents[kind] → agents.default → 空（コード側デフォルトのみ）。 */
export function resolveAgentSystemPrompt(
  kind: string,
  agents: Record<string, ResolvedAgentDefinition> | undefined,
): string {
  const agent = agents?.[kind] ?? agents?.default;
  return agent?.systemPrompt ?? '';
}
