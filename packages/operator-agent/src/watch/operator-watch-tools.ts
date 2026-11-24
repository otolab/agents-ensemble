import type { ConductorJsonValue, ConductorTool } from '@agents-ensemble/core/operator-runtime';
import { jsonToolResult as toolResult } from '../internal/operator-utils.js';
import { MAX_REPOSITORY_AUTO_WATCHES, MIN_REPOSITORY_SCAN_INTERVAL_MS, MAX_REPOSITORY_SCAN_INTERVAL_MS } from './operator-repository-watch-state.js';
import { MIN_POLL_INTERVAL_MS, MAX_POLL_INTERVAL_MS, MAX_DEBOUNCE_MS, MAX_MESSAGE_DEBOUNCE_MS, requireNonEmptyString } from './operator-watch-validation.js';
import type { OperatorWatchPool } from './types.js';

export function createRegisterSessionWatchTool(
  pool: OperatorWatchPool,
): ConductorTool {
  return {
    name: 'register_session_watch',
    description:
      'Register a persistent manual watch for a saved Issue session, independently of live automatic discovery and the repository-watch limit. Reports new open questions, open-to-answered transitions, and disappearance from the observed question list. Each report identifies whether it came from live harness UDS or saved SessionResumeStore/YAML. answeredBy: operator records the operator role and does not distinguish a human on the Issue TTY from operator-agent; only answeredBy: conductor means a conductor-side answer. A question disappearing from the list without answer data is unconfirmed, not resolved.',
    inputSchema: {
      type: 'object',
      properties: {
        conductorAgentId: { type: 'string' },
        pollIntervalMs: {
          type: 'integer',
          minimum: MIN_POLL_INTERVAL_MS,
          maximum: MAX_POLL_INTERVAL_MS,
          description: 'Per-session polling interval in milliseconds (default 2000).',
        },
        debounceMs: {
          type: 'integer',
          minimum: 0,
          maximum: MAX_DEBOUNCE_MS,
          description:
            'Watch report quiet window in milliseconds (default 250). When conductor-message listen is active, watch reports also wait for its messageDebounceMs window.',
        },
      },
      required: ['conductorAgentId'],
      additionalProperties: false,
    },
    execute: async (args) => {
      const watch = await pool.register(
        requireToolString(args.conductorAgentId, 'conductorAgentId'),
        {
          pollIntervalMs: optionalNumber(args.pollIntervalMs, 'pollIntervalMs'),
          debounceMs: optionalNumber(args.debounceMs, 'debounceMs'),
        },
      );
      return toolResult(watch as unknown as ConductorJsonValue);
    },
  };
}

export function createUnregisterSessionWatchTool(
  pool: OperatorWatchPool,
): ConductorTool {
  return {
    name: 'unregister_session_watch',
    description: 'Remove the saved session watch registration. If it belongs to a repository watch, suppress its repository-driven automatic re-registration. removed is false when no saved registration exists, including a live-discovery-only watch. Independent live automatic discovery is not disabled: a live watch may remain active or resume on a later scan, even when removed is true. Do not report that all monitoring has stopped based on this result alone; inspect the session watch status.',
    inputSchema: {
      type: 'object',
      properties: { conductorAgentId: { type: 'string' } },
      required: ['conductorAgentId'],
      additionalProperties: false,
    },
    execute: async (args) => {
      const conductorAgentId = requireToolString(
        args.conductorAgentId,
        'conductorAgentId',
      );
      const removed = await pool.unregister(conductorAgentId);
      return toolResult({ conductorAgentId, removed });
    },
  };
}

export function createRegisterRepositoryWatchTool(
  pool: OperatorWatchPool,
): ConductorTool {
  return {
    name: 'register_repository_watch',
    description:
      'Enable a profile-scoped watch for one exact GitHub owner/repo. A profile can register up to 20 repositories; registering a new repository beyond that limit fails, while registering an existing repository updates its settings. Separately, repository-driven automatic session watches are limited to 20 runs per profile; independent live automatic discovery and manual session watches are outside that limit. Existing saved runs become the baseline and are eligible for automatic watch; later runs are discovered on the repository scan interval. Registration and first-observed times survive operator-agent restarts.',
    inputSchema: {
      type: 'object',
      properties: {
        githubRepo: {
          type: 'string',
          description: 'Exact GitHub repository in owner/repo form.',
        },
        scanIntervalMs: {
          type: 'integer',
          minimum: MIN_REPOSITORY_SCAN_INTERVAL_MS,
          maximum: MAX_REPOSITORY_SCAN_INTERVAL_MS,
          description: 'Repository discovery interval (default 30000).',
        },
        pollIntervalMs: {
          type: 'integer',
          minimum: MIN_POLL_INTERVAL_MS,
          maximum: MAX_POLL_INTERVAL_MS,
          description: 'Repository-driven session watch polling interval in milliseconds (default 10000).',
        },
        debounceMs: {
          type: 'integer',
          minimum: 0,
          maximum: MAX_DEBOUNCE_MS,
          description: 'Watch report quiet window (default 250).',
        },
      },
      required: ['githubRepo'],
      additionalProperties: false,
    },
    execute: async (args) => {
      const config = await pool.registerRepository(
        requireToolString(args.githubRepo, 'githubRepo'),
        {
          scanIntervalMs: optionalNumber(args.scanIntervalMs, 'scanIntervalMs'),
          pollIntervalMs: optionalNumber(args.pollIntervalMs, 'pollIntervalMs'),
          debounceMs: optionalNumber(args.debounceMs, 'debounceMs'),
        },
      );
      return toolResult({
        ...config,
        baselineRunCount: config.managedSessionIds.length +
          config.manualSessionIds.length,
        autoWatchLimit: MAX_REPOSITORY_AUTO_WATCHES,
      } as unknown as ConductorJsonValue);
    },
  };
}

export function createUnregisterRepositoryWatchTool(
  pool: OperatorWatchPool,
): ConductorTool {
  return {
    name: 'unregister_repository_watch',
    description:
      'Remove the repository watch registration, stopping its scans and repository-managed session watches. Explicit manual watches and independent live automatic discovery are unaffected; a live watch may remain active or resume, even when removed is true. Do not report that all monitoring has stopped based on this result alone; inspect the session watch status. First-observed history is retained for future registration.',
    inputSchema: {
      type: 'object',
      properties: {
        githubRepo: {
          type: 'string',
          description: 'Exact GitHub repository in owner/repo form.',
        },
      },
      required: ['githubRepo'],
      additionalProperties: false,
    },
    execute: async (args) => {
      const githubRepo = requireToolString(args.githubRepo, 'githubRepo');
      const removed = await pool.unregisterRepository(githubRepo);
      return toolResult({ githubRepo, removed });
    },
  };
}

export function createRegisterConductorMessageListenTool(
  pool: OperatorWatchPool,
): ConductorTool {
  return {
    name: 'register_conductor_message_listen',
    description:
      'Listen for new successful conductor responses from a running Issue session. The first live poll establishes a baseline; subsequent messages are polled over UDS and debounced into one report. Related watch reports for the same session share this quiet window. No offline fallback is used.',
    inputSchema: {
      type: 'object',
      properties: {
        conductorAgentId: { type: 'string' },
        messageDebounceMs: {
          type: 'integer',
          minimum: 0,
          maximum: MAX_MESSAGE_DEBOUNCE_MS,
          description:
            'Quiet period in milliseconds before nearby conductor responses are reported (default 10000).',
        },
      },
      required: ['conductorAgentId'],
      additionalProperties: false,
    },
    execute: async (args) => {
      const listener = await pool.registerConductorMessageListen(
        requireToolString(args.conductorAgentId, 'conductorAgentId'),
        {
          messageDebounceMs: optionalNumber(
            args.messageDebounceMs,
            'messageDebounceMs',
          ),
        },
      );
      return toolResult(listener as unknown as ConductorJsonValue);
    },
  };
}

export function createUnregisterConductorMessageListenTool(
  pool: OperatorWatchPool,
): ConductorTool {
  return {
    name: 'unregister_conductor_message_listen',
    description: 'Stop listening for conductor responses from an Issue session.',
    inputSchema: {
      type: 'object',
      properties: { conductorAgentId: { type: 'string' } },
      required: ['conductorAgentId'],
      additionalProperties: false,
    },
    execute: async (args) => {
      const conductorAgentId = requireToolString(
        args.conductorAgentId,
        'conductorAgentId',
      );
      const removed = await pool.unregisterConductorMessageListen(
        conductorAgentId,
      );
      return toolResult({ conductorAgentId, removed });
    },
  };
}

function optionalNumber(
  value: ConductorJsonValue | undefined,
  name: string,
): number | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== 'number') throw new Error(`${name} must be an integer.`);
  return value;
}

function requireToolString(
  value: ConductorJsonValue | undefined,
  name: string,
): string {
  if (typeof value !== 'string') throw new Error(`${name} must be a string.`);
  return requireNonEmptyString(value, name);
}
