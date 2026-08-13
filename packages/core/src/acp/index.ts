export {
  NdJsonLineBuffer,
  parseMessage,
  serializeMessage,
  isJsonRpcResponse,
  isJsonRpcRequest,
  isJsonRpcNotification,
} from './json-rpc.js';
export type {
  JsonRpcMessage,
  JsonRpcRequest,
  JsonRpcNotification,
  JsonRpcResponse,
  JsonRpcError,
} from './json-rpc.js';

export { JsonRpcPeer } from './json-rpc-peer.js';
export type {
  JsonRpcPeerOptions,
  NotificationHandler,
  RequestHandler,
} from './json-rpc-peer.js';

export { AcpClient, terminateChildProcess } from './acp-client.js';
export type {
  AcpClientOptions,
  AcpClientStreams,
  SessionUpdateHandler,
} from './acp-client.js';

export { spawnAcpProcess, runAcpSession } from './acp-process.js';
export type {
  SpawnAcpProcessOptions,
  RunAcpSessionOptions,
  ChildProcess,
} from './acp-process.js';

export { AcpBridge } from './acp-bridge.js';
export type {
  AcpBridgeConnectOptions,
  AcpBridgeRunSessionOptions,
} from './acp-bridge.js';

export {
  DEFAULT_PERMISSION_DECISION,
} from './types.js';
export { extractAcpToolName } from './extract-acp-tool-name.js';
export type {
  AcpPromptBlock,
  AcpTextPromptBlock,
  SessionUpdateNotification,
  PromptResult,
  LlmUsageSnapshot,
  PermissionDecision,
  PermissionHandler,
} from './types.js';
export {
  KNOWN_ACP_SESSION_UPDATE_KINDS,
} from './session-update-kinds.js';
export type {
  AcpSessionUpdateKind,
  KnownAcpSessionUpdateKind,
} from './session-update-kinds.js';
