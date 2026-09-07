/** Representative ACP `session/request_permission` payloads seen by the harness. */
export const permissionRequestFixtures = {
  dogfoodingExecute: {
    sessionId: '01a07a33-d3c1-7ff2-a36a-0f43c2486e45',
    toolCall: {
      toolCallId: 'exec-c7c466aa-8399-4554-89c8-c56a81033df9',
      rawInput: { command: 'pnpm test' },
    },
  },
  executeWithJsonRawInput: {
    sessionId: 'session-execute-json',
    toolCall: {
      toolCallId: 'exec-json-1',
      kind: 'execute',
      rawInput: '{"command":"pnpm test --filter=core"}',
    },
  },
  readPath: {
    sessionId: 'session-read',
    toolCall: {
      toolCallId: 'read-1',
      kind: 'read',
      rawInput: { path: 'packages/core/src/index.ts' },
    },
  },
  editPath: {
    sessionId: 'session-edit',
    tool_call: {
      toolCallId: 'edit-1',
      kind: 'edit',
      raw_input: { filePath: 'packages/cli/src/session-log-lines.ts' },
    },
  },
  executeIdOnly: {
    sessionId: 'session-execute-id-only',
    toolCall: {
      toolCallId: 'exec-id-only-1',
    },
  },
} as const;
