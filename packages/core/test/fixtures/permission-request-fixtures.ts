/** ACP `session/request_permission` payload examples for representative wire shapes. */
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
  /** Cursor ACP v1-shaped params with synthetic identifiers and edit contents. */
  editCursorAcpV1: {
    sessionId: 'session-cursor-edit-v1',
    toolCall: {
      toolCallId: 'edit-cursor-1234567890',
      title: 'Edit permission summary renderer',
      kind: 'edit',
      status: 'pending',
      rawInput: {
        filePath:
          'packages/core/src/permission/format-permission-summary-for-operator.ts',
        edits: [{ oldString: 'old value', newString: 'new value' }],
      },
      locations: [
        {
          path: 'packages/core/src/permission/format-permission-summary-for-operator.ts',
          line: 42,
        },
      ],
    },
    options: [
      { optionId: 'allow-once', kind: 'allow_once', name: 'Allow once' },
      { optionId: 'reject-once', kind: 'reject_once', name: 'Reject' },
    ],
  },
  editCursorAcpV1LocationsOnly: {
    sessionId: 'session-cursor-edit-v1-locations',
    toolCall: {
      toolCallId: 'edit-cursor-location-123456',
      title: 'Edit permission summary renderer',
      kind: 'edit',
      status: 'pending',
      rawInput: {
        edits: [{ oldString: 'old value', newString: 'new value' }],
      },
      locations: [
        {
          path: 'packages/core/src/permission/format-permission-summary-for-operator.ts',
          line: 42,
        },
      ],
    },
    options: [
      { optionId: 'allow-once', kind: 'allow_once', name: 'Allow once' },
      { optionId: 'reject-once', kind: 'reject_once', name: 'Reject' },
    ],
  },
  executeIdOnly: {
    sessionId: 'session-execute-id-only',
    toolCall: {
      toolCallId: 'exec-id-only-1',
    },
  },
} as const;
