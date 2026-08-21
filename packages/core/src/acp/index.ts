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

export {
  spawnAcpProcess,
  runAcpSession,
} from './acp-process.js';
export {
  ACP_PRESET_BIN_NAMES,
  ACP_PRESET_EXTERNAL_CLI,
  ACP_PRESET_OPTIONAL_PACKAGES,
} from './acp-preset-bins.js';
export {
  resolveAcpBin,
  resolveAcpBinFromPath,
  resolveBundledAcpBin,
} from './resolve-bundled-acp-bin.js';
export {
  AcpPresetPrerequisiteError,
  finalizeResolvedAcpSpawn,
  formatAcpExternalCliInstallHint,
  formatAcpPresetInstallHint,
  resolveAcpSpawnExecutable,
  validateAcpPresetPrerequisites,
  validateWorkerAcpPrerequisites,
} from './validate-acp-preset-prerequisites.js';
export {
  resolveAcpAuthenticateStrategy,
  resolveBuiltinAcpAuthenticateStrategy,
} from './resolve-acp-auth.js';
export type { AcpAuthenticateStrategy } from './resolve-acp-auth.js';
export {
  ENSEMBLE_DEFAULT_ACP_CLI_ENV,
  resolveBuiltinAcpPreset,
  resolveDefaultAcpSpawn,
  resolveWorkerAcpSpawn,
  resolveWorkerAcpSpawns,
  resolveAcpConfig,
  parseProfileAcpConfig,
  acpSpawnFingerprint,
  assertAcpSpawnMatchesResume,
  resolvedAcpSpawnToOptions,
  listBuiltinAcpPresetIds,
  isBuiltinAcpPresetId,
} from './resolve-acp-spawn.js';
export type {
  BuiltinAcpPresetId,
  AcpPresetId,
  ResolvedAcpSpawn,
  AcpSpawnFingerprint,
  DefaultAcpResolutionOptions,
} from './resolve-acp-spawn.js';
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
