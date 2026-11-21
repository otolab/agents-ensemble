import { join } from 'node:path';
import { resolveEnsemblePaths, type EnsemblePaths } from '../ensemble-paths.js';
import { parseWorkspaceSessionUrl } from '../workspace-run/session-url.js';

export type SessionPersistenceScope =
  | { kind: 'issue'; issueUrl: string }
  | { kind: 'workspace'; slugKey: string };

export function resolveSessionPersistenceScope(
  issueUrl: string,
): SessionPersistenceScope {
  const workspace = parseWorkspaceSessionUrl(issueUrl);
  if (workspace) {
    return { kind: 'workspace', slugKey: workspace.slugKey };
  }
  return { kind: 'issue', issueUrl: issueUrl.trim() };
}

export function sessionResumeStorePathForScope(
  repoRoot: string,
  scope: SessionPersistenceScope,
  conductorAgentId: string,
): string {
  const paths = resolveEnsemblePaths({ repoRoot });
  return resumeStorePathFromPaths(paths, scope, conductorAgentId);
}

export function sessionDataDirForScope(
  repoRoot: string,
  scope: SessionPersistenceScope,
  conductorAgentId: string,
): string {
  const paths = resolveEnsemblePaths({ repoRoot });
  return sessionDataDirFromPaths(paths, scope, conductorAgentId);
}

export function openQuestionsPathForScope(
  repoRoot: string,
  scope: SessionPersistenceScope,
  conductorAgentId: string,
): string {
  const paths = resolveEnsemblePaths({ repoRoot });
  if (scope.kind === 'workspace') {
    return paths.workspaceOpenQuestionsPath(scope.slugKey, conductorAgentId);
  }
  return paths.canonicalOpenQuestionsPath(scope.issueUrl, conductorAgentId);
}

export function sessionStatePathForScope(
  repoRoot: string,
  scope: SessionPersistenceScope,
  conductorAgentId: string,
): string {
  const paths = resolveEnsemblePaths({ repoRoot });
  if (scope.kind === 'workspace') {
    return paths.workspaceSessionStatePath(scope.slugKey, conductorAgentId);
  }
  return paths.canonicalSessionStatePath(scope.issueUrl, conductorAgentId);
}

export function toolCallHistoryPathForScope(
  repoRoot: string,
  scope: SessionPersistenceScope,
  conductorAgentId: string,
): string {
  const paths = resolveEnsemblePaths({ repoRoot });
  if (scope.kind === 'workspace') {
    return paths.workspaceToolCallHistoryPath(scope.slugKey, conductorAgentId);
  }
  return paths.canonicalToolCallHistoryPath(scope.issueUrl, conductorAgentId);
}

function resumeStorePathFromPaths(
  paths: EnsemblePaths,
  scope: SessionPersistenceScope,
  conductorAgentId: string,
): string {
  if (scope.kind === 'workspace') {
    return paths.workspaceSessionResumeStorePath(
      scope.slugKey,
      conductorAgentId,
    );
  }
  return paths.canonicalSessionResumeStorePath(scope.issueUrl, conductorAgentId);
}

function sessionDataDirFromPaths(
  paths: EnsemblePaths,
  scope: SessionPersistenceScope,
  conductorAgentId: string,
): string {
  if (scope.kind === 'workspace') {
    return paths.workspaceSessionDataDir(scope.slugKey, conductorAgentId);
  }
  return join(
    paths.canonicalRepoSessionsDir(scope.issueUrl),
    conductorAgentId,
  );
}