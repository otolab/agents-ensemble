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
        '',
      ].join('\n'),
    );

    await expect(loadOperatorAgentConfiguration(userRoot)).resolves.toMatchObject({
      version: 1,
      defaultProfile: 'work',
      common: {
        conductor: { backend: 'pi', model: 'common-model' },
        pi: { agentDir: '~/.ensemble/pi' },
      },
      profiles: {
        work: {
          include: ['otolab/*'],
          conductor: { model: 'work-model' },
          prompt: {
            instructions: ['Review saved sessions across selected repositories.'],
          },
          pi: { projectDir: 'pi', skills: false },
        },
      },
    });
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
});
