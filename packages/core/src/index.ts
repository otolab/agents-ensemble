/** Shared orchestration types and logic for agents-ensemble. */

export const PACKAGE_NAME = '@agents-ensemble/core';

export {
  NdJsonLineBuffer,
  parseMessage,
  serializeMessage,
  isJsonRpcResponse,
  isJsonRpcRequest,
  isJsonRpcNotification,
} from './acp/json-rpc.js';
export type {
  JsonRpcMessage,
  JsonRpcRequest,
  JsonRpcNotification,
  JsonRpcResponse,
  JsonRpcError,
} from './acp/json-rpc.js';

export { JsonRpcPeer } from './acp/json-rpc-peer.js';
export type { JsonRpcPeerOptions, NotificationHandler } from './acp/json-rpc-peer.js';

export { FakeAcpServer, startFakeAcpServer } from './acp/testing/fake-acp-server.js';
export type {
  FakeAcpServerOptions,
  FakeAcpPromptResult,
} from './acp/testing/fake-acp-server.js';

export { createInProcessStreamPair } from './acp/testing/stream-pair.js';
export type { InProcessStreamPair } from './acp/testing/stream-pair.js';
