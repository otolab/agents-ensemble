import type { SDKCustomTool } from '@cursor/sdk';
import { parseIssueUrl } from '../issue/issue-ref.js';
import {
  DEFAULT_GITHUB_WATCH_KINDS,
  type ExplicitPullRequestWatch,
  type GitHubMonitorCursor,
} from './github-monitor-cursor.js';
import type { GitHubUpdateKind } from './github-update-types.js';
import { yamlToolResult } from '../dispatch/yaml-tool-result.js';

const PULL_REQUEST_WATCH_KINDS = new Set<GitHubUpdateKind>(
  DEFAULT_GITHUB_WATCH_KINDS,
);

export interface GitHubWatchRegistration extends ExplicitPullRequestWatch {
  prNumber: number;
}

export interface RegisterGitHubWatchToolOptions {
  issueUrl: string;
  /** The mutable session cursor that is persisted by the conductor session. */
  getCursor: () => GitHubMonitorCursor;
  /** Called only when a PR is newly registered. */
  onRegistered?: (registration: GitHubWatchRegistration) => void | Promise<void>;
  /** Test hook for deterministic registration timestamps. */
  now?: () => Date;
}

export function createRegisterGitHubWatchTool(
  options: RegisterGitHubWatchToolOptions,
): Record<string, SDKCustomTool> {
  return {
    register_github_watch: {
      description: [
        'Register a pull request for the harness GitHub monitor.',
        'Provide prNumber or prUrl; the pull request must belong to the session Issue repository.',
        'If kinds is omitted, monitor PR reviews, review comments, and CI completion.',
        'Registering the same pull request more than once is a no-op.',
      ].join(' '),
      inputSchema: {
        type: 'object',
        properties: {
          prNumber: {
            type: 'integer',
            minimum: 1,
            description: 'Pull request number (provide this or prUrl)',
          },
          prUrl: {
            type: 'string',
            description: 'GitHub pull request URL (provide this or prNumber)',
          },
          kinds: {
            type: 'array',
            items: {
              type: 'string',
              enum: [...DEFAULT_GITHUB_WATCH_KINDS],
            },
            description:
              'Optional PR update kinds to monitor; defaults to review, review_comment, and ci.completed',
          },
        },
      },
      async execute(args) {
        const issue = parseIssueUrl(options.issueUrl);
        const numberFromArgs = parsePullRequestNumber(args.prNumber);
        const urlRef = parsePullRequestUrl(args.prUrl);

        if (numberFromArgs === undefined && urlRef === undefined) {
          throw new Error('register_github_watch requires prNumber or prUrl');
        }

        if (urlRef && !sameRepository(issue, urlRef)) {
          throw new Error(
            'register_github_watch prUrl must belong to the same repository as the session Issue',
          );
        }

        if (
          numberFromArgs !== undefined &&
          urlRef !== undefined &&
          numberFromArgs !== urlRef.number
        ) {
          throw new Error(
            'register_github_watch prNumber and prUrl refer to different pull requests',
          );
        }

        const prNumber = numberFromArgs ?? urlRef!.number;
        const url = `https://github.com/${issue.owner}/${issue.repo}/pull/${prNumber}`;
        const requestedKinds = parseKinds(args.kinds);
        const cursor = options.getCursor();
        cursor.explicitPullRequests ??= {};
        const key = String(prNumber);
        const existing = cursor.explicitPullRequests[key];
        const kinds = existing
          ? resolveKinds(existing.kinds)
          : requestedKinds;

        if (!existing) {
          const registration: GitHubWatchRegistration = {
            prNumber,
            registeredAt: (options.now ?? (() => new Date()))().toISOString(),
            kinds,
          };
          cursor.explicitPullRequests[key] = {
            registeredAt: registration.registeredAt,
            kinds: [...kinds],
          };
          await options.onRegistered?.(registration);
        }

        return yamlToolResult('register_github_watch', {
          ok: true,
          prNumber,
          url,
          kinds,
          message: existing
            ? 'Pull request is already registered for the harness GitHub monitor'
            : 'Registered for harness GitHub monitor',
        });
      },
    },
  };
}

function parsePullRequestNumber(value: unknown): number | undefined {
  if (value === undefined) return undefined;

  if (typeof value === 'number') {
    if (Number.isSafeInteger(value) && value > 0) return value;
  } else if (typeof value === 'string' && /^\d+$/.test(value.trim())) {
    const parsed = Number(value.trim());
    if (Number.isSafeInteger(parsed) && parsed > 0) return parsed;
  }

  throw new Error('register_github_watch prNumber must be a positive integer');
}

function parsePullRequestUrl(value: unknown):
  | { owner: string; repo: string; number: number }
  | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new Error('register_github_watch prUrl must be a non-empty URL');
  }

  const match = /^https?:\/\/github\.com\/([^/]+)\/([^/]+)\/pull\/(\d+)\/?$/.exec(
    value.trim(),
  );
  if (!match) {
    throw new Error(
      'register_github_watch prUrl must be a GitHub pull request URL',
    );
  }

  const number = Number(match[3]);
  if (!Number.isSafeInteger(number) || number <= 0) {
    throw new Error('register_github_watch prUrl must contain a valid PR number');
  }

  return { owner: match[1]!, repo: match[2]!, number };
}

function sameRepository(
  issue: { owner: string; repo: string },
  pr: { owner: string; repo: string },
): boolean {
  return (
    issue.owner.toLowerCase() === pr.owner.toLowerCase() &&
    issue.repo.toLowerCase() === pr.repo.toLowerCase()
  );
}

function parseKinds(value: unknown): GitHubUpdateKind[] {
  if (value === undefined) return [...DEFAULT_GITHUB_WATCH_KINDS];
  if (!Array.isArray(value)) {
    throw new Error('register_github_watch kinds must be an array');
  }

  const kinds: GitHubUpdateKind[] = [];
  for (const item of value) {
    if (typeof item !== 'string' || !PULL_REQUEST_WATCH_KINDS.has(item as GitHubUpdateKind)) {
      throw new Error(
        'register_github_watch kinds must contain only pr.review, pr.review_comment, or ci.completed',
      );
    }
    if (!kinds.includes(item as GitHubUpdateKind)) {
      kinds.push(item as GitHubUpdateKind);
    }
  }
  return kinds;
}

function resolveKinds(kinds: GitHubUpdateKind[] | undefined): GitHubUpdateKind[] {
  if (!kinds) return [...DEFAULT_GITHUB_WATCH_KINDS];
  return parseKinds(kinds);
}
