import type { ConductorAgent, ConductorAgentCreateOptions, ConductorAgentFactory, ConductorAgentHandle, ConductorBackend } from '@agents-ensemble/core/operator-runtime';
import type { OperatorDispatchBatch } from '../dispatch/operator-dispatch.js';
import type { OperatorAgentConfiguration, OperatorAgentProfile, OperatorAgentSchedulingConfig } from '../config/operator-agent-config.js';
import type { OperatorAgentTuiLogOptions } from '../tui/operator-agent-tui.js';

export interface RunOperatorAgentOptions {
  profile?: string;
  repoFilters?: string[];
  resumeId?: string;
  /** @deprecated Use resumeId. */
  resume?: string;
  newSession?: boolean;
}

export interface OperatorAgentInput extends NodeJS.ReadableStream {
  isTTY?: boolean;
  isRaw?: boolean;
  setRawMode?: (mode: boolean) => unknown;
}

export interface OperatorAgentOutput extends NodeJS.WritableStream {
  isTTY?: boolean;
  columns?: number;
  rows?: number;
}

export interface RunOperatorAgentDependencies {
  stdin?: OperatorAgentInput;
  stdout?: OperatorAgentOutput;
  stderr?: OperatorAgentOutput;
  userEnsembleRoot?: string;
  agentFactory?: ConductorAgentFactory;
  /** Controls automatic discovery in isolated tests. */
  autoDiscoverSessions?: boolean;
}

export interface OperatorRuntime {
  userEnsembleRoot: string;
  workspace: string;
  profileName: string;
  profile: OperatorAgentProfile;
  config: OperatorAgentConfiguration;
  repoFilters: string[];
  backend: ConductorBackend;
  modelId: string;
  reasoning?: string;
  mcpServers?: ConductorAgentCreateOptions['mcpServers'];
  piResourceRoots: { agentDir: string; projectDir: string };
  systemPrompt: string;
  scheduling: Required<OperatorAgentSchedulingConfig>;
}

export interface OperatorAgentHandle extends ConductorAgentHandle {
  factory: ConductorAgentFactory;
  agentOptions: ConductorAgentCreateOptions;
}

export interface OperatorAgentDispatchPayload {
  batch: OperatorDispatchBatch;
}

export interface OperatorTtyChannels {
  harness(detail: string, options?: { color?: string }): void;
  observation(detail: string, options?: { color?: string }): void;
}

export type OperatorPiActivityEvent =
  | { kind: 'compaction'; value: Parameters<NonNullable<ConductorAgentCreateOptions['onCompactionEvent']>>[0] }
  | { kind: 'retry'; value: Parameters<NonNullable<ConductorAgentCreateOptions['onRetryEvent']>>[0] };

export interface OperatorPiActivity {
  listener?: (event: OperatorPiActivityEvent) => void;
}

export interface OperatorTtyLogEntry {
  channel: 'harness' | 'observation';
  detail: string;
  options?: OperatorAgentTuiLogOptions;
}

export interface OperatorTtyLogRouter {
  append: (
    channel: OperatorTtyLogEntry['channel'],
    detail: string,
    options?: OperatorAgentTuiLogOptions,
  ) => void;
  attach: (sink: (entry: OperatorTtyLogEntry) => void) => () => void;
  drain: () => OperatorTtyLogEntry[];
}
