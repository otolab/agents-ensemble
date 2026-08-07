import { allowOnce, deny, type PermissionAskHandler } from '../permission/permission-broker.js';
import type { HumanInquiryHandler } from './human-inquiry.js';
import { permissionRequestToHumanInquiry } from './permission-inquiry.js';

export function createPermissionAskHandler(
  onHumanInquiry: HumanInquiryHandler,
): PermissionAskHandler {
  return async (request) => {
    const inquiry = permissionRequestToHumanInquiry(request);
    const response = await onHumanInquiry(inquiry);
    return response.approved ? allowOnce() : deny();
  };
}
