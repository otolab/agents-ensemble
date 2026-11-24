import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  loadOperatorAgentConfiguration,
  normalizeRepositoryPattern,
  operatorAgentConfigPath,
  parseOperatorAgentConfiguration,
  repositoryMatchesPatterns,
  resolveOperatorAgentScheduling,
  resolveOperatorPath,
  validateProfileName,
} from './operator-agent-config.js';

describe('operator-agent config', () => {
  let userRoot = '';

  afterEach(async () => {
    if (userRoot) await rm(userRoot, { recursive: true, force: true });
    userRoot = '';
  });

  it('loads the fixed operator config with profile includes and provider settings', async () => {
    userRoot = await mkdtemp(join(tmpdir(), 'ensemble-operator-config-'));
    await writeFile(
      operatorAgentConfigPath(userRoot),
      [
        'version: 1',
        'defaultProfile: work',
        'common:',
        '  conductor:',
        '    backend: pi',
        '    model: common-model',
        '  pi:',
        '    agentDir: ~/.ensemble/pi',
        '  mcp:',
        '    servers:',
        '      - shared',
        'profiles:',
        '  work:',
        '    include:',
        '      - otolab/*',
        '    conductor:',
        '      model: work-model',
        '    prompt:',
        '      instructions:',
        '        - Review saved sessions across selected repositories.',
        '    pi:',
        '      projectDir: pi',
        '      skills: false',
        '    mcp:',
        '      servers:',
        '        - github',
        '',
      ].join('\n'),
    );

    await expect(loadOperatorAgentConfiguration(userRoot)).resolves.toMatchObject({
      version: 1,
      defaultProfile: 'work',
      common: {
        conductor: { backend: 'pi', model: 'common-model' },
        pi: { agentDir: '~/.ensemble/pi' },
        mcp: { servers: ['shared'] },
      },
      profiles: {
        work: {
          include: ['otolab/*'],
          conductor: { model: 'work-model' },
          prompt: {
            instructions: ['Review saved sessions across selected repositories.'],
          },
          pi: { projectDir: 'pi', skills: false },
          mcp: { servers: ['github'] },
        },
      },
    });
  });

  it('validates selected MCP server names', () => {
    expect(() =>
      parseOperatorAgentConfiguration({
        version: 1,
        profiles: {
          work: { mcp: { servers: ['github', '  '] } },
        },
      }),
    ).toThrow(/non-empty MCP server names/u);
    expect(() =>
      parseOperatorAgentConfiguration({
        version: 1,
        profiles: {
          work: { mcp: { servers: ['github', 'github'] } },
        },
      }),
    ).toThrow(/server names must be unique/u);
  });

  it('validates profile path segments and repository filters', () => {
    expect(validateProfileName('work.profile-1')).toBe('work.profile-1');
    expect(() => validateProfileName('../outside')).toThrow(/safe path segment/u);
    expect(normalizeRepositoryPattern('OtOlab/Agents-Ensemble')).toBe(
      'otolab/agents-ensemble',
    );
    expect(() => normalizeRepositoryPattern('owner/*/extra')).toThrow(
      /expected/u,
    );
    expect(
      repositoryMatchesPatterns('OtOlab/agents-ensemble', ['otolab/*']),
    ).toBe(true);
    expect(
      repositoryMatchesPatterns('other/agents-ensemble', ['otolab/*']),
    ).toBe(false);
  });

  it('rejects unknown keys and a default profile that is not defined', () => {
    expect(() =>
      parseOperatorAgentConfiguration({
        version: 1,
        defaultProfile: 'missing',
        profiles: { available: {} },
      }),
    ).toThrow(/not defined/u);
    expect(() =>
      parseOperatorAgentConfiguration({
        version: 1,
        profiles: { work: { repoRoot: '/tmp/repository' } },
      }),
    ).toThrow(/unknown key/u);
  });

  it('resolves explicit profile paths against the intended root', () => {
    expect(resolveOperatorPath('pi', '/home/user/.ensemble/operator-agents/work')).toBe(
      '/home/user/.ensemble/operator-agents/work/pi',
    );
    expect(
      resolveOperatorPath('~/shared-pi', '/home/user/.ensemble'),
    ).toBe(join(process.env.HOME ?? '/home/user', 'shared-pi'));
  });

  it('resolves scheduling defaults with field-wise profile overrides', () => {
    expect(
      resolveOperatorAgentScheduling(
        {
          batchMaxWaitMs: 45_000,
          focusInactivityTimeoutMs: 12 * 60_000,
        },
        {
          idleAgingMs: 7 * 60_000,
        },
      ),
    ).toEqual({
      batchMaxWaitMs: 45_000,
      pushThreshold: 10,
      sessionStateWeight: 1,
      openQuestionWeight: 10,
      conductorMessageWeight: 5,
      idleCandidateWeight: 1,
      idlePhaseThresholdMs: 30 * 60_000,
      staleRunningThresholdMs: 60 * 60_000,
      idleAgingMs: 7 * 60_000,
      focusInactivityTimeoutMs: 12 * 60_000,
      idleReevaluationIntervalMs: 60_000,
    });
  });

  it('validates scheduling trial ranges in common and profile scopes', () => {
    expect(
      parseOperatorAgentConfiguration({
        version: 1,
        common: {
          scheduling: {
            batchMaxWaitMs: 30_000,
            idlePhaseThresholdMs: 30 * 60_000,
            staleRunningThresholdMs: 60 * 60_000,
            idleAgingMs: 5 * 60_000,
            focusInactivityTimeoutMs: 10 * 60_000,
            idleReevaluationIntervalMs: 60_000,
          },
        },
        profiles: {
          work: { scheduling: { idleAgingMs: 2 * 60_000 } },
        },
      }),
    ).toMatchObject({
      common: {
        scheduling: { batchMaxWaitMs: 30_000 },
      },
      profiles: {
        work: { scheduling: { idleAgingMs: 2 * 60_000 } },
      },
    });

    expect(() =>
      parseOperatorAgentConfiguration({
        version: 1,
        profiles: {
          work: { scheduling: { batchMaxWaitMs: 9_999 } },
        },
      }),
    ).toThrow(/batchMaxWaitMs.*10000.*120000/u);
  });

  it.each([
    ['batchMaxWaitMs', 9_999, 120_001],
    ['idlePhaseThresholdMs', 599_999, 7_200_001],
    ['staleRunningThresholdMs', 1_799_999, 14_400_001],
    ['idleAgingMs', 59_999, 1_800_001],
    ['focusInactivityTimeoutMs', 179_999, 1_800_001],
    ['idleReevaluationIntervalMs', 29_999, 300_001],
  ])('rejects out-of-range %s values', (key, belowMinimum, aboveMaximum) => {
    for (const value of [belowMinimum, aboveMaximum]) {
      expect(() =>
        parseOperatorAgentConfiguration({
          version: 1,
          profiles: {
            work: { scheduling: { [key]: value } },
          },
        }),
      ).toThrow(new RegExp(`${key}.*milliseconds`, 'u'));
    }
  });

  it.each([
    ['idlePhaseThresholdMs', 10 * 60_000, 120 * 60_000],
    ['staleRunningThresholdMs', 30 * 60_000, 240 * 60_000],
    ['idleAgingMs', 60_000, 30 * 60_000],
    ['idleReevaluationIntervalMs', 30_000, 5 * 60_000],
  ])('accepts the documented minimum and maximum for %s', (key, minimum, maximum) => {
    for (const value of [minimum, maximum]) {
      expect(() =>
        parseOperatorAgentConfiguration({
          version: 1,
          profiles: {
            work: { scheduling: { [key]: value } },
          },
        }),
      ).not.toThrow();
    }
  });
});
