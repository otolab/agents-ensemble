import type { PermissionRequest } from '../permission/permission-request.js';
import type { HumanInquiryRequest } from './human-inquiry.js';

export function permissionRequestToHumanInquiry(
  request: PermissionRequest,
): HumanInquiryRequest {
  const session = request.sessionId ? ` (session=${request.sessionId})` : '';
  return {
    kind: 'permission',
    question: `Worker permission: ${request.toolName}${session}. Allow?`,
    responseType: 'yes_no',
    toolName: request.toolName,
    sessionId: request.sessionId,
  };
}
