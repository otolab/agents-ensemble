import type { ConductorToolSet } from '../conductor/conductor-tool.js';
import { yamlToolResult } from '../dispatch/yaml-tool-result.js';
import {
  parseGitHubWatchTarget,
  type GitHubWatchTarget,
} from './register-github-watch-tool.js';
import type { GitHubMonitorCursor } from './github-monitor-cursor.js';

export interface UnregisterGitHubWatchToolOptions {
  issueUrl: string;
  /** The mutable session cursor that is persisted by the conductor session. */
  getCursor: () => GitHubMonitorCursor;
  /** Called only when a PR was explicitly registered and is now removed. */
  onUnregistered?: (prNumber: number) => void | Promise<void>;
}

export function createUnregisterGitHubWatchTool(
  options: UnregisterGitHubWatchToolOptions,
): ConductorToolSet {
  return {
    unregister_github_watch: {
      name: 'unregister_github_watch',
      description: [
        'Stop explicitly monitoring a pull request with the harness GitHub monitor.',
        'Provide prNumber or prUrl; the pull request must belong to the session Issue repository.',
        'This removes only the explicit watch; a pull request still linked by GitHub Search remains monitored.',
        'If the pull request is not explicitly registered, return ok: false without throwing.',
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
        },
      },
      async execute(args) {
        const target: GitHubWatchTarget = parseGitHubWatchTarget(
          options.issueUrl,
          args,
          'unregister_github_watch',
        );
        const cursor = options.getCursor();
        const key = String(target.prNumber);
        const explicitPullRequests = cursor.explicitPullRequests;
        if (!explicitPullRequests?.[key]) {
          return yamlToolResult('unregister_github_watch', {
            ok: false,
            prNumber: target.prNumber,
            url: target.url,
            message:
              'Pull request is not explicitly registered for the harness GitHub monitor',
          });
        }

        delete explicitPullRequests[key];
        await options.onUnregistered?.(target.prNumber);
        return yamlToolResult('unregister_github_watch', {
          ok: true,
          prNumber: target.prNumber,
          url: target.url,
          message: 'Unregistered from harness GitHub monitor',
        });
      },
    },
  };
}
