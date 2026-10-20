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
  /** ACP v1 wire request shape; identifiers and edit contents are synthetic. */
  editCursorAcpV1: {
    jsonrpc: '2.0',
    id: 0,
    method: 'session/request_permission',
    params: {
      sessionId: 'session-cursor-edit-v1',
      toolCall: {
        toolCallId: 'edit-cursor-1234567890',
        title: 'Edit File',
        kind: 'edit',
        status: 'pending',
        rawInput: {
          filePath:
            '/workspace/agents-ensemble/packages/core/src/permission/format-permission-summary-for-operator.ts',
          oldString: '<redacted>',
          newString: '<redacted>',
        },
        locations: [
          {
            path: '/workspace/agents-ensemble/packages/core/src/permission/format-permission-summary-for-operator.ts',
            line: 42,
          },
        ],
      },
      options: [
        { optionId: 'allow-once', kind: 'allow_once', name: 'Allow once' },
        { optionId: 'reject-once', kind: 'reject_once', name: 'Reject' },
      ],
    },
  },
  /** Same synthetic ACP v1 frame, with the target available only in locations. */
  editCursorAcpV1LocationsOnly: {
    jsonrpc: '2.0',
    id: 1,
    method: 'session/request_permission',
    params: {
      sessionId: 'session-cursor-edit-v1-locations',
      toolCall: {
        toolCallId: 'edit-cursor-location-123456',
        title: 'Edit File',
        kind: 'edit',
        status: 'pending',
        rawInput: {
          oldString: '<redacted>',
          newString: '<redacted>',
        },
        locations: [
          {
            path: '/workspace/agents-ensemble/packages/core/src/permission/format-permission-summary-for-operator.ts',
            line: 42,
          },
        ],
      },
      options: [
        { optionId: 'allow-once', kind: 'allow_once', name: 'Allow once' },
        { optionId: 'reject-once', kind: 'reject_once', name: 'Reject' },
      ],
    },
  },
  executeIdOnly: {
    sessionId: 'session-execute-id-only',
    toolCall: {
      toolCallId: 'exec-id-only-1',
    },
  },
  /** Edit information split between earlier session/update and permission params. */
  editPriorToolCallUpdates: [
    {
      sessionUpdate: 'tool_call',
      toolCallId: 'call-edit-from-update',
      kind: 'edit',
      title: 'Edit File',
      status: 'pending',
      rawInput: {
        oldString: '<redacted>',
        newString: '<redacted>',
      },
    },
    {
      sessionUpdate: 'tool_call_update',
      toolCallId: 'call-edit-from-update',
      status: 'in_progress',
      locations: [
        {
          path: '/workspace/agents-ensemble/packages/core/src/example.ts',
          line: 27,
        },
      ],
    },
  ],
  editPermissionIdOnly: {
    toolCall: { toolCallId: 'call-edit-from-update' },
    options: [
      { optionId: 'allow-once', kind: 'allow_once', name: 'Allow once' },
      { optionId: 'reject-once', kind: 'reject_once', name: 'Reject' },
    ],
    backendExtension: { source: 'permission-rpc' },
  },
} as const;
