/** JSON-RPC 2.0 message types (newline-delimited over stdio). */

export interface JsonRpcRequest {
  jsonrpc: '2.0';
  id: number | string;
  method: string;
  params?: unknown;
}

export interface JsonRpcNotification {
  jsonrpc: '2.0';
  method: string;
  params?: unknown;
}

export interface JsonRpcError {
  code: number;
  message: string;
  data?: unknown;
}

export interface JsonRpcResponse {
  jsonrpc: '2.0';
  id: number | string;
  result?: unknown;
  error?: JsonRpcError;
}

export type JsonRpcMessage =
  | JsonRpcRequest
  | JsonRpcNotification
  | JsonRpcResponse;

export function isJsonRpcResponse(msg: JsonRpcMessage): msg is JsonRpcResponse {
  return 'id' in msg && ('result' in msg || 'error' in msg);
}

export function isJsonRpcRequest(msg: JsonRpcMessage): msg is JsonRpcRequest {
  return 'id' in msg && 'method' in msg && !('result' in msg) && !('error' in msg);
}

export function isJsonRpcNotification(msg: JsonRpcMessage): msg is JsonRpcNotification {
  return 'method' in msg && !('id' in msg);
}

export function serializeMessage(message: JsonRpcMessage): string {
  return `${JSON.stringify(message)}\n`;
}

export function parseMessage(line: string): JsonRpcMessage {
  const trimmed = line.trim();
  if (!trimmed) {
    throw new Error('Empty JSON-RPC line');
  }
  const parsed: unknown = JSON.parse(trimmed);
  if (
    typeof parsed !== 'object' ||
    parsed === null ||
    (parsed as { jsonrpc?: string }).jsonrpc !== '2.0'
  ) {
    throw new Error('Invalid JSON-RPC 2.0 message');
  }
  return parsed as JsonRpcMessage;
}

/** Incomplete lines from a byte stream. */
export class NdJsonLineBuffer {
  private buffer = '';

  push(chunk: string): string[] {
    this.buffer += chunk;
    const lines = this.buffer.split('\n');
    this.buffer = lines.pop() ?? '';
    return lines.filter((line) => line.trim().length > 0);
  }

  flush(): string[] {
    if (!this.buffer.trim()) {
      this.buffer = '';
      return [];
    }
    const line = this.buffer;
    this.buffer = '';
    return [line];
  }
}
