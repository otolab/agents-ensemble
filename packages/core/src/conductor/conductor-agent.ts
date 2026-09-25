import type { McpServers } from '../mcp/load-mcp-config.js';
import type { ConductorToolSet } from './conductor-tool.js';

/** Backend-neutral options used when creating or resuming a conductor. */
export interface ConductorAgentCreateOptions {
  cwd: string;
  /** Compiled conductor instructions, including the Issue context. */
  systemPrompt: string;
  apiKey?: string;
  modelId?: string;
  mcpServers?: McpServers;
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
  rawCostCents: number;
  chargedCents: number;
}

export interface ConductorAgentUsage {
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
  onToolCallStarted?: (info: ConductorToolCallStartedInfo) => void;
}

/** Backend-neutral conductor session handle used by the harness. */
export interface ConductorAgent {
  readonly agentId: string;
  send(
    prompt: string,
    callbacks?: ConductorSendCallbacks,
  ): Promise<ConductorSendResult>;
  reload(): Promise<void>;
  getUsage(): Promise<ConductorAgentUsage>;
  setSystemPrompt(systemPrompt: string): Promise<void>;
  close(): Promise<void>;
}

/** Factory boundary used by the harness to select a conductor backend. */
export interface ConductorAgentFactory {
  create(options: ConductorAgentCreateOptions): Promise<ConductorAgent>;
  resume(
    agentId: string,
    options: ConductorAgentCreateOptions,
  ): Promise<ConductorAgent>;
}
