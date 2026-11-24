import {
  listUserLocatedSessionResumeStoresPage,
  type LocatedSessionResumeStore,
  type SessionResumeStoreDuplicateDiagnostic,
} from '@agents-ensemble/core/operator-runtime';
import { normalizeRepositoryPattern, repositoryMatchesPatterns } from '../config/operator-agent-config.js';
import {
  MAX_REPOSITORY_AUTO_WATCHES,
  type OperatorRepositoryWatchState,
  type RepositoryWatchConfig,
} from './operator-repository-watch-state.js';
import type { OperatorWatchState } from './operator-watch-state.js';
import type { CreateOperatorWatchPoolOptions } from './types.js';

/** Shared state is read through accessors because refresh replaces both objects. */
export interface WatchRepositoryContext {
  readonly root: string;
  readonly options: CreateOperatorWatchPoolOptions;
  readonly state: OperatorWatchState;
  readonly repositoryState: OperatorRepositoryWatchState;
  readonly onResumeStoreDuplicate: (diagnostic: SessionResumeStoreDuplicateDiagnostic) => void;
}

export function createWatchRepositoryOperations(context: WatchRepositoryContext) {
  const { root, options, onResumeStoreDuplicate } = context;
  const assertRepositoryAllowed = (value: string): string => {
    const repository = normalizeRepositoryPattern(value);
    if (repository.endsWith('/*')) {
      throw new Error('githubRepo must name one exact owner/repo.');
    }
    const includes = options.profileIncludes?.length
      ? options.profileIncludes.map((pattern) =>
        normalizeRepositoryPattern(pattern),
      )
      : undefined;
    if (
      includes &&
      !repositoryMatchesPatterns(repository, includes)
    ) {
      throw new Error(
        `Repository ${repository} is outside the selected profile include scope.`,
      );
    }
    const filters = options.repoFilters?.length
      ? options.repoFilters.map((pattern) =>
        normalizeRepositoryPattern(pattern),
      )
      : undefined;
    if (filters && !repositoryMatchesPatterns(repository, filters)) {
      throw new Error(
        `Repository ${repository} is outside the active --repo-filter scope.`,
      );
    }
    return repository;
  };
  const repositoryIsInActiveScope = (repository: string): boolean => {
    try {
      assertRepositoryAllowed(repository);
      return true;
    } catch {
      return false;
    }
  };
  const nextFirstObservedAt = (): number => {
    let latest = -1;
    for (const discoveries of Object.values(context.repositoryState.discoveries)) {
      for (const discovery of Object.values(discoveries)) {
        latest = Math.max(latest, discovery.firstObservedAt);
      }
    }
    return Math.max(Date.now(), latest + 1);
  };
  const listRepositoryStores = async (
    githubRepo: string,
  ): Promise<LocatedSessionResumeStore[]> => {
    const sessions: LocatedSessionResumeStore[] = [];
    let cursor: string | undefined;
    do {
      const page = await listUserLocatedSessionResumeStoresPage(
        {
          githubRepo,
          limit: 500,
          ...(cursor ? { cursor } : {}),
        },
        {
          userEnsembleRoot: root,
          onDuplicate: onResumeStoreDuplicate,
        },
      );
      sessions.push(...page.sessions);
      cursor = page.nextCursor;
    } while (cursor);
    return sessions;
  };
  const reconcileRepositoryAutoWatches = () => {
    const previousManaged = new Set<string>();
    const candidates: Array<{
      id: string;
      githubRepo: string;
      firstObservedAt: number;
      config: RepositoryWatchConfig;
    }> = [];
    for (const config of Object.values(context.repositoryState.watches)) {
      for (const id of config.managedSessionIds) previousManaged.add(id);
      if (!repositoryIsInActiveScope(config.githubRepo)) continue;
      const discoveries = context.repositoryState.discoveries[config.githubRepo] ?? {};
      const manual = new Set(config.manualSessionIds);
      const suppressed = new Set(config.suppressedSessionIds);
      for (const id of config.managedSessionIds) {
        const discovery = discoveries[id];
        if (!discovery || manual.has(id) || suppressed.has(id)) continue;
        candidates.push({
          id,
          githubRepo: config.githubRepo,
          firstObservedAt: discovery.firstObservedAt,
          config,
        });
      }
    }
    candidates.sort(
      (left, right) =>
        right.firstObservedAt - left.firstObservedAt ||
        left.githubRepo.localeCompare(right.githubRepo) ||
        left.id.localeCompare(right.id),
    );
    const selected = new Map(
      candidates
        .slice(0, MAX_REPOSITORY_AUTO_WATCHES)
        .map((candidate) => [candidate.id, candidate]),
    );
    for (const id of previousManaged) {
      const stillManual = Object.values(context.repositoryState.watches).some(
        (config) => config.manualSessionIds.includes(id),
      );
      if (!selected.has(id) && !stillManual) delete context.state.watches[id];
    }
    for (const candidate of selected.values()) {
      if (candidate.config.manualSessionIds.includes(candidate.id)) continue;
      context.state.watches[candidate.id] = {
        conductorAgentId: candidate.id,
        pollIntervalMs: candidate.config.pollIntervalMs,
        debounceMs: candidate.config.debounceMs,
      };
    }
  };
  return { assertRepositoryAllowed, repositoryIsInActiveScope, nextFirstObservedAt, listRepositoryStores, reconcileRepositoryAutoWatches };
}
