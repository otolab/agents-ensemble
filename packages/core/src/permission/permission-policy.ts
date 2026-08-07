import type { PermissionRequest } from './permission-request.js';

export type PermissionVerdict = 'allow' | 'deny' | 'ask';

export interface PermissionPolicyRules {
  /** Tool names (exact, case-insensitive) to auto-allow. */
  allowTools?: string[];
  /** Tool names (exact, case-insensitive) to auto-deny. */
  denyTools?: string[];
  /**
   * Read-only tools auto-allowed when allowTools is omitted.
   * Ignored when allowTools is explicitly set (even empty).
   */
  allowReadOnlyTools?: boolean;
}

const DEFAULT_READ_ONLY_TOOLS = new Set([
  'read',
  'grep',
  'glob',
  'semanticsearch',
  'listmcpresources',
  'fetchmcpresource',
]);

function normalizeToolName(toolName: string): string {
  return toolName.trim().toLowerCase();
}

function matchesList(toolName: string, list: string[] | undefined): boolean {
  if (!list?.length) return false;
  const normalized = normalizeToolName(toolName);
  return list.some((entry) => normalizeToolName(entry) === normalized);
}

export function evaluatePermissionPolicy(
  request: PermissionRequest,
  rules: PermissionPolicyRules = {},
): PermissionVerdict {
  if (matchesList(request.toolName, rules.denyTools)) {
    return 'deny';
  }

  if (rules.allowTools !== undefined) {
    return matchesList(request.toolName, rules.allowTools) ? 'allow' : 'ask';
  }

  if (rules.allowReadOnlyTools !== false) {
    if (DEFAULT_READ_ONLY_TOOLS.has(normalizeToolName(request.toolName))) {
      return 'allow';
    }
  }

  return 'ask';
}
