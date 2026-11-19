import type { McpServerConfigMap } from '../mcp/load-mcp-config.js';
import type { ConductorToolSet } from './conductor-tool.js';

export interface ConductorPiResourceOptions {
  /** Optional Pi user resource root override. */
  agentDir?: string;
  /** Optional Pi project resource root override. */
  projectDir?: string;
}

/** Backend-neutral options used when creating or resuming a conductor. */
export interface ConductorAgentCreateOptions {
  cwd: string;
  /** Compiled conductor instructions, including the Issue context. */
  systemPrompt: string;
  /** Whether backend built-in coding tools are available; omitted means enabled. */
  builtinTools?: boolean;
  /**
   * Pi backend only: load and expand Pi prompt templates and explicit skill
   * invocations; omitted means enabled.
   */
  piPromptResources?: boolean;
  /** Pi backend only: use Pi standard skill discovery; omitted means enabled. */
  piSkills?: boolean;
  /** Pi backend only: load configured extension modules and tools; omitted means enabled. */
  piExtensions?: boolean;
  /**
   * Pi backend only: register Pi's built-in MCP, Codemode, and Tool Search
   * extensions; omitted means enabled.
   */
  piInternalExtensions?: boolean;
  /**
   * Operator-agent Pi only: publish MCP tools directly and omit the Codemode extension.
   * Omitted for Issue conductors, which keep the existing MCP exposure policy.
   */
  operatorPiMcpMode?: 'direct';
  /** Pi backend only: called when `compaction_end` reports a successful compaction. */
  onContextCompaction?: () => void;
  apiKey?: string;
  /**
   * Resolved model override. `default` selects the backend default; omission
   * lets custom factories keep their existing default.
   */
  modelId?: string;
  /** Resolved conductor reasoning / thinking level; each backend validates its own support. */
  reasoning?: string;
  mcpServers?: McpServerConfigMap;
  /** Cursor SDK only: prevent loading ambient settings files and MCP servers. */
  disableCursorAmbientSettings?: boolean;
  /** Pi-only resource root overrides; ignored by other backends. */
  pi?: ConductorPiResourceOptions;
  /** Pi-only Issue identity used to resolve the canonical transcript directory. */
  issueUrl?: string;
  /** Pi-only explicit transcript directory override. Defaults to the canonical user store from issueUrl. */
  sessionDir?: string;
  /** CWDs from the saved session whose Pi transcript may be resumed in this clone. */
  resumeCwds?: readonly string[];
  customTools?: ConductorToolSet;
  onStreamText?: (text: string) => void;
}

/** @deprecated Use `ConductorAgentCreateOptions` instead. */
export type ConductorAgentOptions = ConductorAgentCreateOptions;

export interface ConductorSendError {
  message: string;
  code?: string;
}

export interface ConductorTokenUsage {
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  reasoningTokens?: number;
  cacheReadTokens?: number;
  cacheWriteTokens?: number;
}

export interface ConductorUsageCost {
  /** Raw cost in cents from a backend billing record; omit estimates. */
  rawCostCents: number;
  /** Charged cost in cents from a backend billing record; omit estimates. */
  chargedCents: number;
}

export interface ConductorAgentUsage {
  /** Backend-reported billing data. Model-rate estimates do not belong here. */
  cost?: ConductorUsageCost;
}

export interface ConductorSendResult {
  runId: string;
  status: string;
  result?: string;
  error?: ConductorSendError;
  usage?: ConductorTokenUsage;
  modelId?: string;
}

export interface ConductorToolCallStartedInfo {
  runId: string;
  tool: string;
  callId: string;
}

export interface ConductorSendCallbacks {
  /** Observable output phases; no reasoning content is exposed. */
  onOutputPhase?: (phase: 'thinking' | 'writing') => void;
  onToolCallStarted?: (info: ConductorToolCallStartedInfo) => void;
  onToolCallCompleted?: (info: ConductorToolCallStartedInfo) => void;
  /** Harness metadata used by provider history projections; never sent to the model. */
  history?: {
    sendCount: number;
    dispatchSource?: string;
  };
}

/** Backend-neutral conductor session handle used by the harness. */
export interface ConductorAgent {
  readonly agentId: string;
  send(
    prompt: string,
    callbacks?: ConductorSendCallbacks,
  ): Promise<ConductorSendResult>;
  /** Cancel the current backend run when supported. */
  cancel?(): Promise<void>;
  reload(): Promise<void>;
  getUsage(): Promise<ConductorAgentUsage>;
  setSystemPrompt(systemPrompt: string): Promise<void>;
  close(): Promise<void>;
  /** Close resources for a resumable TTY session without changing normal exit cleanup. */
  closeForResume?(): Promise<void>;
}

/** Factory boundary used by the harness to select a conductor backend. */
export interface ConductorAgentFactory {
  create(options: ConductorAgentCreateOptions): Promise<ConductorAgent>;
  resume(
    agentId: string,
    options: ConductorAgentCreateOptions,
  ): Promise<ConductorAgent>;
}
