import { createHash } from 'node:crypto';
import { join, normalize, resolve } from 'node:path';
import { resolveUserEnsembleRoot } from './resolve-user-ensemble-root.js';

export interface ResolveEnsemblePathsOptions {
  repoRoot: string;
  /** Override the OS home directory, primarily for isolated tests. */
  home?: string;
  /** Override the user-level Ensemble directory, primarily for isolated tests. */
  userEnsembleRoot?: string;
}

/**
 * Resolve user and project paths used by ensemble runtime persistence.
 *
 * Session data is stored under the user root and partitioned by the normalized
 * absolute repository root. Project paths are returned for settings, legacy
 * reads, and the existing repository-local Git worktree layout.
 */
export function resolveEnsemblePaths(
  options: ResolveEnsemblePathsOptions,
) {
  const repoRoot = normalize(resolve(options.repoRoot));
  const userRoot = normalize(
    resolve(
      resolveUserEnsembleRoot({
        home: options.home,
        userEnsembleRoot: options.userEnsembleRoot,
      }),
    ),
  );
  const projectRoot = join(repoRoot, '.ensemble');
  const repoKey = createHash('sha256').update(repoRoot).digest('hex');
  const sessionsRoot = join(userRoot, 'sessions');
  const sessionsDir = join(sessionsRoot, repoKey);
  const sessionDataDir = (conductorAgentId: string) =>
    join(sessionsDir, conductorAgentId);

  return {
    repoRoot,
    repoKey,
    userRoot,
    projectRoot,
    sessionsRoot,
    sessionsDir,
    legacySessionsDir: join(projectRoot, 'sessions'),
    legacySessionResumeStorePath: (conductorAgentId: string) =>
      join(projectRoot, 'sessions', `${conductorAgentId}.json`),
    sessionDataDir,
    sessionResumeStorePath: (conductorAgentId: string) =>
      join(sessionsDir, `${conductorAgentId}.json`),
    openQuestionsPath: (conductorAgentId: string) =>
      join(sessionDataDir(conductorAgentId), 'open-questions.yaml'),
    sessionStatePath: (conductorAgentId: string) =>
      join(sessionDataDir(conductorAgentId), 'session-state.yaml'),
    legacyOpenQuestionsPath: (conductorAgentId: string) =>
      join(
        projectRoot,
        'sessions',
        conductorAgentId,
        'open-questions.yaml',
      ),
    legacySessionStatePath: (conductorAgentId: string) =>
      join(
        projectRoot,
        'sessions',
        conductorAgentId,
        'session-state.yaml',
      ),
    toolCallHistoryPath: (conductorAgentId: string) =>
      join(sessionsDir, `${conductorAgentId}.tool-calls`),
    legacyToolCallHistoryPath: (conductorAgentId: string) =>
      join(
        projectRoot,
        'sessions',
        `${conductorAgentId}.tool-calls`,
      ),
    piSessionsDir: join(sessionsDir, 'pi'),
    legacyPiSessionsDirForCwd: (cwd = repoRoot) =>
      join(cwd, '.ensemble', 'pi', 'sessions'),
    operatorAgentDir: join(userRoot, 'operator-agent', repoKey),
    operatorAgentSessionPath: join(
      userRoot,
      'operator-agent',
      repoKey,
      'session.json',
    ),
    operatorWatchStatePath: join(
      userRoot,
      'operator-agent',
      repoKey,
      'watch-state.json',
    ),
    legacyOperatorAgentSessionPath: join(
      projectRoot,
      'operator-agent',
      'session.json',
    ),
    legacyOperatorWatchStatePath: join(
      projectRoot,
      'operator-agent',
      'watch-state.json',
    ),
    operatorPiSessionsDir: join(
      userRoot,
      'operator-agent',
      repoKey,
      'pi-sessions',
    ),
    legacyPiSessionsDir: join(projectRoot, 'pi', 'sessions'),
    worktreesDir: join(projectRoot, 'worktrees'),
  };
}

export type EnsemblePaths = ReturnType<typeof resolveEnsemblePaths>;
