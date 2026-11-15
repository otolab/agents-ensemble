import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  clearOperatorAgentState,
  listOperatorAgentStates,
  loadOperatorAgentState,
  operatorAgentStatePath,
  operatorPiSessionDirectory,
  saveOperatorAgentState,
  type OperatorAgentState,
} from './operator-agent-state.js';

describe('operator-agent conversation records', () => {
  let userRoot = '';

  afterEach(async () => {
    if (userRoot) await rm(userRoot, { recursive: true, force: true });
    userRoot = '';
  });

  it('stores global records and Pi transcripts under the operatorAgentId', async () => {
    userRoot = await mkdtemp(join(tmpdir(), 'ensemble-operator-record-'));
    const first = makeRecord('operator-first', 10);
    const second = makeRecord('operator-second', 20);

    await saveOperatorAgentState(userRoot, first);
    await saveOperatorAgentState(userRoot, second);

    await expect(
      readFile(operatorAgentStatePath(userRoot, first.operatorAgentId), 'utf8'),
    ).resolves.toContain('"profile": "personal"');
    expect(operatorPiSessionDirectory(userRoot, first.operatorAgentId)).toBe(
      join(
        userRoot,
        'operator-agents',
        'conversations',
        'operator-first',
        'pi-sessions',
      ),
    );
    await expect(
      listOperatorAgentStates(userRoot),
    ).resolves.toEqual([second, first]);
    await expect(
      loadOperatorAgentState(userRoot, first.operatorAgentId),
    ).resolves.toEqual(first);
  });

  it('rejects a provider session collision and keeps the original record', async () => {
    userRoot = await mkdtemp(join(tmpdir(), 'ensemble-operator-record-'));
    const original = makeRecord('operator-stable', 10);
    await saveOperatorAgentState(userRoot, original);

    await expect(
      saveOperatorAgentState(userRoot, {
        ...original,
        providerSessionId: 'different-provider-session',
      }),
    ).rejects.toThrow(/different provider session/u);
    await expect(
      loadOperatorAgentState(userRoot, original.operatorAgentId),
    ).resolves.toEqual(original);
  });

  it('does not discover or delete profile-less legacy state or transcripts', async () => {
    userRoot = await mkdtemp(join(tmpdir(), 'ensemble-operator-record-'));
    const oldDirectory = join(userRoot, 'operator-agent', 'old-repo-key');
    await mkdir(oldDirectory, { recursive: true });
    await writeFile(
      join(oldDirectory, 'session.json'),
      JSON.stringify({
        version: 1,
        agentId: 'legacy-provider-id',
        backend: 'pi',
        repoRoot: '/old/checkout',
      }),
    );
    const transcriptDirectory = join(oldDirectory, 'pi-sessions');
    await mkdir(transcriptDirectory, { recursive: true });
    await writeFile(join(transcriptDirectory, 'legacy.jsonl'), 'legacy log');

    await expect(listOperatorAgentStates(userRoot)).resolves.toEqual([]);
    await expect(
      loadOperatorAgentState(userRoot, 'legacy-provider-id'),
    ).resolves.toBeUndefined();
    await clearOperatorAgentState(userRoot, 'legacy-provider-id').catch(() => {});
    await expect(
      readFile(join(oldDirectory, 'session.json'), 'utf8'),
    ).resolves.toContain('legacy-provider-id');
    await expect(
      readFile(join(transcriptDirectory, 'legacy.jsonl'), 'utf8'),
    ).resolves.toBe('legacy log');
  });

  it('removes only a selected record while preserving its Pi transcript directory', async () => {
    userRoot = await mkdtemp(join(tmpdir(), 'ensemble-operator-record-'));
    const record = makeRecord('operator-selected', 10);
    const transcript = join(
      operatorPiSessionDirectory(userRoot, record.operatorAgentId),
      'transcript.jsonl',
    );
    await mkdir(dirname(transcript), { recursive: true });
    await writeFile(transcript, 'conversation');
    await saveOperatorAgentState(userRoot, record);

    await clearOperatorAgentState(userRoot, record.operatorAgentId);

    await expect(
      loadOperatorAgentState(userRoot, record.operatorAgentId),
    ).resolves.toBeUndefined();
    await expect(readFile(transcript, 'utf8')).resolves.toBe('conversation');
  });
});

function makeRecord(
  operatorAgentId: string,
  updatedAt: number,
): OperatorAgentState {
  return {
    version: 2,
    operatorAgentId,
    providerSessionId: `provider-${operatorAgentId}`,
    backend: 'pi',
    profile: 'personal',
    workspace: '/home/user/.ensemble/operator-agents/personal',
    piResourceRoots: {
      agentDir: '/home/user/.ensemble/pi',
      projectDir: '/home/user/.ensemble/operator-agents/personal/pi',
    },
    createdAt: 1,
    updatedAt,
  };
}
