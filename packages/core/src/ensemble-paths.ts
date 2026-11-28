import { createHash } from 'node:crypto';
import { join, normalize, resolve, sep } from 'node:path';
import { parseIssueUrl } from './issue/issue-ref.js';
import { resolveUserEnsembleRoot } from './resolve-user-ensemble-root.js';

export interface ResolveEnsemblePathsOptions {
  repoRoot: string;
  /** Override the OS home directory, primarily for isolated tests. */
  home?: string;
  /** Override the user-level Ensemble directory, primarily for isolated tests. */
  userEnsembleRoot?: string;
  /** Effective Pi user resource root for builtin worker storage. */
  piAgentDir?: string;
}

/**
 * Resolve user and project paths used by ensemble runtime persistence.
 *
 * Issue-session runtime data is stored under the user root and keyed by
 * canonical GitHub slug. The repository-root hash remains available for Pi
 * worker storage and for explicitly named legacy-source paths. Runtime
 * SessionResumeStore, sidecar, and transcript reads do not use those paths.
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
  const workspacesRoot = join(userRoot, 'workspaces');
  const legacyHashSessionsDir = join(sessionsRoot, repoKey);
  const piUserDir = join(userRoot, 'pi');
  const piWorkerRoot = join(
    options.piAgentDir
      ? normalize(resolve(options.piAgentDir))
      : piUserDir,
    'worker',
    repoKey,
  );
  const piWorkerDirectoryName = (workerName: string) => {
    const slug = workerName
      .normalize('NFKD')
      .replace(/[^A-Za-z0-9_-]+/gu, '-')
      .replace(/^[.-]+|[.-]+$/gu, '')
      .slice(0, 48);
    const key = createHash('sha256').update(workerName).digest('hex').slice(0, 12);
    return `${slug || 'worker'}-${key}`;
  };
  const legacyPiWorkerDirectory = (workerName: string) =>
    join(piWorkerRoot, piWorkerDirectoryName(workerName));
  const piWorkerDirectory = (workerName: string, issueNumber: number) => {
    if (!Number.isSafeInteger(issueNumber) || issueNumber < 1) {
      throw new Error('Pi worker storage requires a positive Issue number.');
    }
    return join(
      piWorkerRoot,
      `issue-${issueNumber}`,
      piWorkerDirectoryName(workerName),
    );
  };
  const piWorkspaceWorkerDirectory = (
    workerName: string,
    workspaceSlugKey: string,
  ) =>
    join(
      piWorkerRoot,
      'workspace',
      workspaceSlugKey,
      piWorkerDirectoryName(workerName),
    );
  const workspaceSlugDirectory = (slugKey: string) =>
    join(workspacesRoot, slugKey);
  const workspaceSessionDataDir = (
    slugKey: string,
    conductorAgentId: string,
  ) => join(workspaceSlugDirectory(slugKey), conductorAgentId);
  const legacyHashSessionDataDir = (conductorAgentId: string) =>
    join(legacyHashSessionsDir, conductorAgentId);
  const canonicalRepoSlug = (issueUrl: string) => {
    const issue = parseIssueUrl(issueUrl);
    if (
      [issue.owner, issue.repo].some(
        (segment) =>
          segment === '.' ||
          segment === '..' ||
          !/^[A-Za-z0-9_.-]+$/u.test(segment),
      )
    ) {
      throw new Error('Invalid GitHub repository path in Issue URL.');
    }
    return join(
      'github.com',
      issue.owner.toLowerCase(),
      issue.repo.toLowerCase(),
    );
  };
  const canonicalRepoSessionsDir = (issueUrl: string) => {
    const directory = resolve(
      sessionsRoot,
      canonicalRepoSlug(issueUrl),
    );
    if (!directory.startsWith(`${resolve(sessionsRoot)}${sep}`)) {
      throw new Error('Invalid GitHub repository path in Issue URL.');
    }
    return directory;
  };
  const canonicalSessionDataDir = (
    issueUrl: string,
    conductorAgentId: string,
  ) => join(canonicalRepoSessionsDir(issueUrl), conductorAgentId);
  const canonicalPiSessionsDir = (issueUrl: string) =>
    join(canonicalRepoSessionsDir(issueUrl), 'pi');

  return {
    repoRoot,
    repoKey,
    userRoot,
    projectRoot,
    piUserDir,
    piWorkerRoot,
    piWorkerDir: piWorkerDirectory,
    legacyPiWorkerDir: legacyPiWorkerDirectory,
    piWorkerSessionsDir: (workerName: string, issueNumber: number) =>
      join(piWorkerDirectory(workerName, issueNumber), 'sessions'),
    piWorkerSessionMapPath: (workerName: string, issueNumber: number) =>
      join(
        piWorkerDirectory(workerName, issueNumber),
        '.pi',
        'pi-acp',
        'session-map.json',
      ),
    sessionsRoot,
    workspacesRoot,
    workspaceSlugDir: workspaceSlugDirectory,
    workspaceNotesDir: (slugKey: string) =>
      join(workspaceSlugDirectory(slugKey), 'notes'),
    workspaceSessionDataDir,
    workspaceSessionResumeStorePath: (
      slugKey: string,
      conductorAgentId: string,
    ) =>
      join(
        workspaceSlugDirectory(slugKey),
        `${conductorAgentId}.json`,
      ),
    workspaceOpenQuestionsPath: (
      slugKey: string,
      conductorAgentId: string,
    ) =>
      join(
        workspaceSessionDataDir(slugKey, conductorAgentId),
        'open-questions.yaml',
      ),
    workspaceSessionStatePath: (
      slugKey: string,
      conductorAgentId: string,
    ) =>
      join(
        workspaceSessionDataDir(slugKey, conductorAgentId),
        'session-state.yaml',
      ),
    workspaceToolCallHistoryPath: (
      slugKey: string,
      conductorAgentId: string,
    ) =>
      join(
        workspaceSlugDirectory(slugKey),
        `${conductorAgentId}.tool-calls`,
      ),
    piWorkspaceWorkerDir: piWorkspaceWorkerDirectory,
    piWorkspaceWorkerSessionsDir: (
      workerName: string,
      workspaceSlugKey: string,
    ) =>
      join(
        piWorkspaceWorkerDirectory(workerName, workspaceSlugKey),
        'sessions',
      ),
    legacyHashSessionsDir,
    canonicalRepoSessionsDir,
    canonicalSessionResumeStorePath: (
      issueUrl: string,
      conductorAgentId: string,
    ) =>
      join(
        canonicalRepoSessionsDir(issueUrl),
        `${conductorAgentId}.json`,
      ),
    canonicalOpenQuestionsPath: (
      issueUrl: string,
      conductorAgentId: string,
    ) =>
      join(
        canonicalSessionDataDir(issueUrl, conductorAgentId),
        'open-questions.yaml',
      ),
    canonicalSessionStatePath: (
      issueUrl: string,
      conductorAgentId: string,
    ) =>
      join(
        canonicalSessionDataDir(issueUrl, conductorAgentId),
        'session-state.yaml',
      ),
    canonicalToolCallHistoryPath: (
      issueUrl: string,
      conductorAgentId: string,
    ) =>
      join(
        canonicalRepoSessionsDir(issueUrl),
        `${conductorAgentId}.tool-calls`,
      ),
    canonicalPiSessionsDir,
    legacySessionsDir: join(projectRoot, 'sessions'),
    legacySessionResumeStorePath: (conductorAgentId: string) =>
      join(projectRoot, 'sessions', `${conductorAgentId}.json`),
    legacyHashSessionDataDir,
    legacyHashSessionResumeStorePath: (conductorAgentId: string) =>
      join(legacyHashSessionsDir, `${conductorAgentId}.json`),
    legacyHashOpenQuestionsPath: (conductorAgentId: string) =>
      join(legacyHashSessionDataDir(conductorAgentId), 'open-questions.yaml'),
    legacyHashSessionStatePath: (conductorAgentId: string) =>
      join(legacyHashSessionDataDir(conductorAgentId), 'session-state.yaml'),
    legacyHashToolCallHistoryPath: (conductorAgentId: string) =>
      join(legacyHashSessionsDir, `${conductorAgentId}.tool-calls`),
    legacyHashPiSessionsDir: join(legacyHashSessionsDir, 'pi'),
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
    legacyToolCallHistoryPath: (conductorAgentId: string) =>
      join(
        projectRoot,
        'sessions',
        `${conductorAgentId}.tool-calls`,
      ),
    legacyPiSessionsDirForCwd: (cwd = repoRoot) =>
      join(cwd, '.ensemble', 'pi', 'sessions'),
    legacyPiSessionsDir: join(projectRoot, 'pi', 'sessions'),
    worktreesDir: join(projectRoot, 'worktrees'),
  };
}

export type EnsemblePaths = ReturnType<typeof resolveEnsemblePaths>;
