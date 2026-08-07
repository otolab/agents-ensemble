import {
  allowOnce,
  createPermissionAskHandler,
  deny,
  type PermissionRequest,
} from '@agents-ensemble/core';
import { promptHumanInquiry } from './prompt-human-inquiry.js';

const permissionAsk = createPermissionAskHandler(promptHumanInquiry);

export async function promptPermissionDecision(request: PermissionRequest) {
  return permissionAsk(request);
}

export { allowOnce, deny };
