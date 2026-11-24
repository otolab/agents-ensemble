import type { IssueRef } from '../issue/issue-ref.js';
import { workspaceSessionUrl } from './session-url.js';
import { workspaceSyntheticIssueNumber } from './slug-key.js';

/** Synthetic IssueRef for worktree / Pi paths in workspace mode (not a GitHub Issue). */
export function resolveWorkspaceIssueRef(slugKey: string): IssueRef {
  const number = workspaceSyntheticIssueNumber(slugKey);
  return {
    owner: 'workspace',
    repo: slugKey.slice(0, 48) || 'local',
    number,
    url: workspaceSessionUrl(slugKey),
  };
}