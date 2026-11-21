import { assertValidSlugKey } from './slug-key.js';

export const WORKSPACE_SESSION_URL_PREFIX = 'workspace://';

/** Canonical `issueUrl` field value for a workspace-scoped conductor session. */
export function workspaceSessionUrl(slugKey: string): string {
  assertValidSlugKey(slugKey);
  return `${WORKSPACE_SESSION_URL_PREFIX}${slugKey}`;
}

export function parseWorkspaceSessionUrl(
  issueUrl: string,
): { slugKey: string } | undefined {
  const trimmed = issueUrl.trim();
  if (!trimmed.startsWith(WORKSPACE_SESSION_URL_PREFIX)) {
    return undefined;
  }
  const slugKey = trimmed.slice(WORKSPACE_SESSION_URL_PREFIX.length);
  if (!slugKey || slugKey.includes('/')) {
    return undefined;
  }
  try {
    assertValidSlugKey(slugKey);
  } catch {
    return undefined;
  }
  return { slugKey };
}

export function isWorkspaceSessionUrl(issueUrl: string): boolean {
  return parseWorkspaceSessionUrl(issueUrl) !== undefined;
}