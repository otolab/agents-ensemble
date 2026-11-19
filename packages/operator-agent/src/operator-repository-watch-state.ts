import { isEnoent, isRecord } from './operator-utils.js';
import { randomUUID } from 'node:crypto';
import { chmod, mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { parseIssueUrl } from '@agents-ensemble/core/operator-runtime';
import {
  normalizeRepositoryPattern,
  validateProfileName,
} from './operator-agent-config.js';

export const OPERATOR_REPOSITORY_WATCH_STATE_VERSION = 1;
export const DEFAULT_REPOSITORY_SCAN_INTERVAL_MS = 30_000;
export const MIN_REPOSITORY_SCAN_INTERVAL_MS = 5_000;
export const MAX_REPOSITORY_SCAN_INTERVAL_MS = 300_000;
export const DEFAULT_REPOSITORY_AUTO_POLL_INTERVAL_MS = 10_000;
export const MAX_REPOSITORY_AUTO_WATCHES = 20;
export const MAX_REPOSITORY_WATCHES = 20;

export interface RepositoryWatchConfig {
  githubRepo: string;
  enabledAt: number;
  lastScanAttemptAt: number | null;
  lastSuccessfulScanAt: number | null;
  lastScanError: 'scan_failed' | null;
  scanIntervalMs: number;
  pollIntervalMs: number;
  debounceMs: number;
  managedSessionIds: string[];
  manualSessionIds: string[];
  suppressedSessionIds: string[];
}

export interface RepositoryRunDiscovery {
  issueUrl: string;
  firstObservedAt: number;
}

export interface OperatorRepositoryWatchState {
  version: typeof OPERATOR_REPOSITORY_WATCH_STATE_VERSION;
  watches: Record<string, RepositoryWatchConfig>;
  discoveries: Record<string, Record<string, RepositoryRunDiscovery>>;
}

export function operatorRepositoryWatchStatePath(
  userEnsembleRoot: string,
  profile: string,
): string {
  validateProfileName(profile);
  return join(
    userEnsembleRoot,
    'operator-agents',
    profile,
    'watch',
    'repository-watch-state.json',
  );
}

export function emptyOperatorRepositoryWatchState(): OperatorRepositoryWatchState {
  return {
    version: OPERATOR_REPOSITORY_WATCH_STATE_VERSION,
    watches: {},
    discoveries: {},
  };
}

export async function loadOperatorRepositoryWatchState(
  path: string,
): Promise<OperatorRepositoryWatchState> {
  let raw: string;
  try {
    raw = await readFile(path, 'utf8');
  } catch (error) {
    if (isEnoent(error)) return emptyOperatorRepositoryWatchState();
    throw error;
  }

  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch (error) {
    throw new Error(
      `Invalid operator repository watch state at ${path}: invalid JSON.`,
      { cause: error },
    );
  }
  if (
    !isRecord(value) ||
    value.version !== OPERATOR_REPOSITORY_WATCH_STATE_VERSION ||
    !isRecord(value.watches) ||
    !isRecord(value.discoveries)
  ) {
    throw new Error(`Invalid operator repository watch state at ${path}.`);
  }

  const watches: OperatorRepositoryWatchState['watches'] = {};
  for (const [key, rawWatch] of Object.entries(value.watches)) {
    if (
      !isRecord(rawWatch) ||
      rawWatch.githubRepo !== key ||
      normalizeRepositoryPattern(key) !== key ||
      key.endsWith('/*') ||
      typeof rawWatch.enabledAt !== 'number' ||
      !Number.isSafeInteger(rawWatch.enabledAt) ||
      rawWatch.enabledAt < 0 ||
      !isBoundedInteger(rawWatch.scanIntervalMs, MIN_REPOSITORY_SCAN_INTERVAL_MS, MAX_REPOSITORY_SCAN_INTERVAL_MS) ||
      !isBoundedInteger(rawWatch.pollIntervalMs, 250, 60_000) ||
      !isBoundedInteger(rawWatch.debounceMs, 0, 10_000) ||
      !isStringArray(rawWatch.managedSessionIds) ||
      !isStringArray(rawWatch.manualSessionIds) ||
      !isStringArray(rawWatch.suppressedSessionIds)
    ) {
      throw new Error(
        `Invalid operator repository watch state at ${path}: watch ${key}.`,
      );
    }
    watches[key] = {
      githubRepo: key,
      enabledAt: rawWatch.enabledAt,
      lastScanAttemptAt:
        rawWatch.lastScanAttemptAt === null ||
        rawWatch.lastScanAttemptAt === undefined
          ? null
          : requireTimestamp(
              rawWatch.lastScanAttemptAt,
              path,
              `watch ${key} lastScanAttemptAt`,
            ),
      lastSuccessfulScanAt:
        rawWatch.lastSuccessfulScanAt === null ||
        rawWatch.lastSuccessfulScanAt === undefined
          ? null
          : requireTimestamp(
              rawWatch.lastSuccessfulScanAt,
              path,
              `watch ${key} lastSuccessfulScanAt`,
            ),
      lastScanError:
        rawWatch.lastScanError === null ||
        rawWatch.lastScanError === undefined
          ? null
          : rawWatch.lastScanError === 'scan_failed'
            ? 'scan_failed'
            : (() => {
                throw new Error(
                  `Invalid operator repository watch state at ${path}: watch ${key} lastScanError.`,
                );
              })(),
      scanIntervalMs: rawWatch.scanIntervalMs,
      pollIntervalMs: rawWatch.pollIntervalMs,
      debounceMs: rawWatch.debounceMs,
      managedSessionIds: [...new Set(rawWatch.managedSessionIds)],
      manualSessionIds: [...new Set(rawWatch.manualSessionIds)],
      suppressedSessionIds: [...new Set(rawWatch.suppressedSessionIds)],
    };
  }
  if (Object.keys(watches).length > MAX_REPOSITORY_WATCHES) {
    throw new Error(
      `Invalid operator repository watch state at ${path}: too many repositories.`,
    );
  }

  const discoveries: OperatorRepositoryWatchState['discoveries'] = {};
  for (const [key, rawRuns] of Object.entries(value.discoveries)) {
    if (
      normalizeRepositoryPattern(key) !== key ||
      !isRecord(rawRuns)
    ) {
      throw new Error(
        `Invalid operator repository watch state at ${path}: discoveries ${key}.`,
      );
    }
    const runs: Record<string, RepositoryRunDiscovery> = {};
    for (const [id, rawDiscovery] of Object.entries(rawRuns)) {
      if (
        !id.trim() ||
        !isRecord(rawDiscovery) ||
        typeof rawDiscovery.issueUrl !== 'string' ||
        typeof rawDiscovery.firstObservedAt !== 'number' ||
        !Number.isSafeInteger(rawDiscovery.firstObservedAt) ||
        rawDiscovery.firstObservedAt < 0
      ) {
        throw new Error(
          `Invalid operator repository watch state at ${path}: discovery ${key}/${id}.`,
        );
      }
      let issueRepository: string;
      try {
        const issue = parseIssueUrl(rawDiscovery.issueUrl);
        issueRepository = `${issue.owner}/${issue.repo}`.toLowerCase();
      } catch {
        throw new Error(
          `Invalid operator repository watch state at ${path}: Issue URL ${key}/${id}.`,
        );
      }
      if (issueRepository !== key) {
        throw new Error(
          `Invalid operator repository watch state at ${path}: repository mismatch for ${id}.`,
        );
      }
      runs[id] = {
        issueUrl: rawDiscovery.issueUrl,
        firstObservedAt: rawDiscovery.firstObservedAt,
      };
    }
    discoveries[key] = runs;
  }

  return {
    version: OPERATOR_REPOSITORY_WATCH_STATE_VERSION,
    watches,
    discoveries,
  };
}

export async function saveOperatorRepositoryWatchState(
  path: string,
  state: OperatorRepositoryWatchState,
): Promise<void> {
  const directory = dirname(path);
  await mkdir(directory, { recursive: true, mode: 0o700 });
  await chmod(directory, 0o700);
  const temporary = `${path}.${process.pid}.${randomUUID()}.tmp`;
  await writeFile(temporary, `${JSON.stringify(state, null, 2)}\n`, {
    encoding: 'utf8',
    mode: 0o600,
  });
  await chmod(temporary, 0o600);
  await rename(temporary, path);
}

function isBoundedInteger(
  value: unknown,
  minimum: number,
  maximum: number,
): value is number {
  return (
    typeof value === 'number' &&
    Number.isSafeInteger(value) &&
    value >= minimum &&
    value <= maximum
  );
}

function requireTimestamp(value: unknown, path: string, field: string): number {
  if (
    typeof value !== 'number' ||
    !Number.isSafeInteger(value) ||
    value < 0
  ) {
    throw new Error(
      `Invalid operator repository watch state at ${path}: ${field}.`,
    );
  }
  return value;
}

function isStringArray(value: unknown): value is string[] {
  return (
    Array.isArray(value) &&
    value.every((item) => typeof item === 'string' && item.trim().length > 0)
  );
}
