import type { ProfileWorkerEntry } from './types.js';
import {
  assertWorkerWorkspaceDirectory,
  resolveWorkerWorkspacePath,
} from './resolve-worker-workspace.js';

export type TeamProfileAvailability = 'available' | 'unusable';

export interface TeamProfileValidationIssue {
  worker: string;
  kind: string;
  workspace: string;
  reason: 'missing' | 'not_directory';
  message: string;
}

export interface TeamProfileWorkspaceValidation {
  availability: TeamProfileAvailability;
  issues?: TeamProfileValidationIssue[];
}

function checkWorkerWorkspaceDirectory(
  path: string,
  workerName: string,
  kind: string,
): TeamProfileValidationIssue | undefined {
  try {
    assertWorkerWorkspaceDirectory(path, workerName);
    return undefined;
  } catch (error) {
    if (!(error instanceof Error)) {
      throw error;
    }
    const reason: TeamProfileValidationIssue['reason'] = error.message.includes(
      'not a directory',
    )
      ? 'not_directory'
      : 'missing';
    return {
      worker: workerName,
      kind,
      workspace: path,
      reason,
      message: error.message,
    };
  }
}

/** team profile の全 worker workspace を検証する。1 体でも不正なら profile 全体を unusable とする。 */
export function validateTeamProfileWorkspaces(
  profile: { workers: ProfileWorkerEntry[] },
  profileDir: string,
  repoRoot: string,
): TeamProfileWorkspaceValidation {
  const issues: TeamProfileValidationIssue[] = [];

  for (const worker of profile.workers) {
    if (!worker.workspace) {
      continue;
    }
    const resolvedPath = resolveWorkerWorkspacePath(
      worker.workspace,
      profileDir,
      repoRoot,
    );
    const issue = checkWorkerWorkspaceDirectory(resolvedPath, worker.name, worker.kind);
    if (issue) {
      issues.push(issue);
    }
  }

  if (issues.length === 0) {
    return { availability: 'available' };
  }

  return { availability: 'unusable', issues };
}

export function formatTeamProfileActivationError(
  profileRef: string,
  issue: TeamProfileValidationIssue,
): string {
  const workerPart = issue.message.replace(/^Worker /, 'worker ');
  return `Cannot use team profile "${profileRef}": ${workerPart}`;
}

/** unusable な profile の activate / 起動を拒否する。`loadProfile` と将来の `select_profile`（#174）が使う。 */
export function assertTeamProfileWorkspacesAvailable(
  profile: { workers: ProfileWorkerEntry[] },
  profileDir: string,
  repoRoot: string,
  profileRef: string,
): void {
  const validation = validateTeamProfileWorkspaces(profile, profileDir, repoRoot);
  if (validation.availability === 'available') {
    return;
  }

  const issue = validation.issues?.[0];
  if (!issue) {
    throw new Error(`Cannot use team profile "${profileRef}": workspace validation failed`);
  }

  throw new Error(formatTeamProfileActivationError(profileRef, issue));
}
