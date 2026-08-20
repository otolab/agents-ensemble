/** Shared orchestration types and logic for agents-ensemble. */

export const PACKAGE_NAME = '@agents-ensemble/core';

export * from './config/index.js';
export * from './acp/index.js';
export * from './workspace/index.js';
export * from './profile/index.js';
export * from './prompt/index.js';
export * from './dispatch/index.js';
export * from './github/index.js';
export * from './conductor/index.js';
export * from './permission/index.js';
export * from './usage/index.js';
export * from './escalation/index.js';
export * from './session/index.js';
export * from './runtime/index.js';

/** @deprecated Import from `@agents-ensemble/core/testing` instead. */
export {
  FakeAcpServer,
  startFakeAcpServer,
  createInProcessStreamPair,
  createTestOperatorInputBinding,
} from './testing/index.js';
/** @deprecated Import from `@agents-ensemble/core/testing` instead. */
export type {
  FakeAcpServerOptions,
  FakeAcpPromptResult,
  InProcessStreamPair,
  TestOperatorInputBinding,
} from './testing/index.js';
