import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  AgentSession,
  DefaultResourceLoader,
  ModelRuntime,
  SettingsManager,
} from '@earendil-works/pi-coding-agent';
import {
  createAssistantMessageEventStream,
  type AssistantMessage,
} from '@earendil-works/pi-ai';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { PiConductorAgent } from '../../src/conductor/pi-conductor-agent.js';

const FIXTURE_MODEL_ID = 'fixture/fixture-model';

interface PiAgentInternals {
  session: AgentSession;
}

function getSession(agent: PiConductorAgent): AgentSession {
  // PiConductorAgent intentionally exposes only the backend-neutral interface.
  // This integration test inspects the real SDK object behind that boundary.
  return (agent as unknown as PiAgentInternals).session;
}

async function writeJson(path: string, value: unknown): Promise<void> {
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`);
}

function createSummaryStream(text: string) {
  const stream = createAssistantMessageEventStream();
  const message: AssistantMessage = {
    role: 'assistant',
    content: [{ type: 'text', text }],
    api: 'openai-completions',
    provider: 'fixture',
    model: 'fixture-model',
    usage: {
      input: 1,
      output: 1,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 2,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
    stopReason: 'stop',
    timestamp: Date.now(),
  };
  queueMicrotask(() => {
    stream.push({ type: 'start', partial: message });
    stream.push({ type: 'done', reason: 'stop', message });
  });
  return stream;
}

describe('Pi headless settings with the real SDK', () => {
  let cwd = '';
  let agentDir = '';
  let ensembleProjectDir = '';
  let piProjectDir = '';
  const agents: PiConductorAgent[] = [];

  afterEach(async () => {
    while (agents.length > 0) {
      await agents.pop()?.close();
    }
    vi.restoreAllMocks();
  });

  async function setupFixture(): Promise<void> {
    cwd = await mkdtemp(join(tmpdir(), 'pi-headless-sdk-project-'));
    agentDir = join(cwd, 'agent-dir');
    ensembleProjectDir = join(cwd, '.ensemble', 'pi');
    piProjectDir = join(cwd, '.pi');
    await Promise.all([
      mkdir(agentDir, { recursive: true }),
      mkdir(ensembleProjectDir, { recursive: true }),
      mkdir(piProjectDir, { recursive: true }),
    ]);

    await writeJson(join(agentDir, 'settings.json'), {
      defaultProvider: 'agent-dir-provider',
      defaultModel: 'agent-dir-model',
      compaction: { enabled: true, reserveTokens: 91_001, keepRecentTokens: 92_001 },
      branchSummary: { reserveTokens: 93_001, skipPrompt: false },
      defaultThinkingLevel: 'high',
      sessionDir: '/tmp/agent-dir-transcript',
      retry: { enabled: true },
    });
    await writeJson(join(piProjectDir, 'settings.json'), {
      defaultProvider: 'pi-project-provider',
      defaultModel: 'pi-project-model',
      compaction: { enabled: true, reserveTokens: 81_001, keepRecentTokens: 82_001 },
      branchSummary: { reserveTokens: 83_001, skipPrompt: false },
      defaultThinkingLevel: 'low',
      sessionDir: '/tmp/pi-project-transcript',
      retry: { enabled: true },
    });
    await writeJson(join(ensembleProjectDir, 'settings.json'), {
      defaultProvider: 'fixture',
      defaultModel: 'fixture-model',
      compaction: {
        enabled: false,
        reserveTokens: 1_001,
        keepRecentTokens: 2_001,
        unsupportedNestedKey: 'must-not-cross-sdk-boundary',
      },
      branchSummary: {
        reserveTokens: 3_001,
        skipPrompt: true,
        unsupportedNestedKey: 'must-not-cross-sdk-boundary',
      },
      sessionDir: '/tmp/ensemble-transcript-must-not-be-used',
      retry: { enabled: false },
    });
    await writeJson(join(ensembleProjectDir, 'models.json'), {
      providers: {
        fixture: {
          api: 'openai-completions',
          baseUrl: 'http://127.0.0.1:1/v1',
          models: [
            {
              id: 'fixture-model',
              name: 'Fixture model',
              contextWindow: 128_000,
              maxTokens: 4_096,
            },
          ],
        },
      },
    });
  }

  function createOptions() {
    return {
      cwd,
      pi: { agentDir, projectDir: ensembleProjectDir },
      modelId: FIXTURE_MODEL_ID,
      apiKey: 'fixture-api-key',
      systemPrompt: 'deterministic integration system prompt',
    };
  }

  function expectSettings(
    session: AgentSession,
    reserveTokens: number,
    keepRecentTokens: number,
    branchReserveTokens: number,
    compactionEnabled = false,
    branchSkipPrompt = true,
  ): void {
    expect(session).toBeInstanceOf(AgentSession);
    expect(session.resourceLoader).toBeInstanceOf(DefaultResourceLoader);
    expect(session.settingsManager).toBeInstanceOf(SettingsManager);

    const settingsManager = session.settingsManager;
    expect(settingsManager.getGlobalSettings()).toEqual({});
    expect(settingsManager.getProjectSettings()).toEqual({});
    expect(settingsManager.getSettings()).toEqual({
      compaction: {
        enabled: compactionEnabled,
        reserveTokens,
        keepRecentTokens,
      },
      branchSummary: {
        reserveTokens: branchReserveTokens,
        skipPrompt: branchSkipPrompt,
      },
    });
    expect(settingsManager.getCompactionSettings(session.model)).toEqual({
      enabled: compactionEnabled,
      reserveTokens,
      keepRecentTokens,
    });
    expect(settingsManager.getBranchSummarySettings()).toEqual({
      reserveTokens: branchReserveTokens,
      skipPrompt: branchSkipPrompt,
    });
    expect(session.autoCompactionEnabled).toBe(compactionEnabled);
    expect(settingsManager.getSettings()).not.toHaveProperty('defaultProvider');
    expect(settingsManager.getSettings()).not.toHaveProperty('defaultThinkingLevel');
    expect(settingsManager.getSettings()).not.toHaveProperty('sessionDir');
    expect(settingsManager.getSettings()).not.toHaveProperty('retry');
  }

  it('keeps create, reload, and resume on the ensemble snapshot across real SDK sessions', async () => {
    await setupFixture();

    const created = await PiConductorAgent.create(createOptions());
    agents.push(created);
    const createdSession = getSession(created);
    expectSettings(createdSession, 1_001, 2_001, 3_001);

    // AgentSession.reload() really clears the in-memory manager and reloads the
    // resource loader. It must not import either Pi standard settings file, and
    // the wrapper must restore its create-time snapshot afterwards.
    await writeJson(join(ensembleProjectDir, 'settings.json'), {
      compaction: { enabled: true, reserveTokens: 11_001, keepRecentTokens: 12_001 },
      branchSummary: { reserveTokens: 13_001, skipPrompt: false },
    });
    await writeJson(join(piProjectDir, 'settings.json'), {
      compaction: { enabled: true, reserveTokens: 71_001, keepRecentTokens: 72_001 },
      branchSummary: { reserveTokens: 73_001, skipPrompt: false },
      sessionDir: '/tmp/reload-pi-project-transcript',
    });
    await created.reload();
    expectSettings(createdSession, 1_001, 2_001, 3_001);

    // Add one real transcript message so SessionManager persists the session
    // file without making a provider request. Resume must read the new
    // .ensemble/pi snapshot, while the SDK's standard project settings remain
    // irrelevant.
    createdSession.sessionManager.appendMessage({
      role: 'user',
      content: [{ type: 'text', text: 'persist this deterministic fixture turn' }],
      timestamp: Date.now(),
    });
    await created.close();

    const resumed = await PiConductorAgent.resume(created.agentId, createOptions());
    agents.push(resumed);
    const resumedSession = getSession(resumed);
    expectSettings(resumedSession, 11_001, 12_001, 13_001, true, false);

    await writeJson(join(ensembleProjectDir, 'settings.json'), {
      compaction: { enabled: false, reserveTokens: 21_001, keepRecentTokens: 22_001 },
      branchSummary: { reserveTokens: 23_001, skipPrompt: true },
    });
    await resumed.reload();
    expectSettings(resumedSession, 11_001, 12_001, 13_001, true, false);
  });

  it('uses the allowlisted settings in real compaction and branch-summary paths', async () => {
    await setupFixture();
    await writeJson(join(ensembleProjectDir, 'settings.json'), {
      compaction: { enabled: false, reserveTokens: 101, keepRecentTokens: 1 },
      branchSummary: { reserveTokens: 103, skipPrompt: false },
    });

    const agent = await PiConductorAgent.create(createOptions());
    agents.push(agent);
    const session = getSession(agent);
    const streamSimple = vi
      .spyOn(ModelRuntime.prototype, 'streamSimple')
      .mockImplementation(() => createSummaryStream('deterministic SDK summary'));

    for (let index = 0; index < 4; index += 1) {
      session.sessionManager.appendMessage({
        role: 'user',
        content: [{ type: 'text', text: `history user ${index} with enough context` }],
        timestamp: Date.now(),
      });
      session.sessionManager.appendMessage({
        role: 'assistant',
        content: [{ type: 'text', text: `history assistant ${index}` }],
        api: 'openai-completions',
        provider: 'fixture',
        model: 'fixture-model',
        usage: {
          input: 1,
          output: 1,
          cacheRead: 0,
          cacheWrite: 0,
          totalTokens: 2,
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
        },
        stopReason: 'stop',
        timestamp: Date.now(),
      });
    }

    await session.compact('keep the fixture summary deterministic');
    expect(streamSimple).toHaveBeenCalled();
    expect(session.sessionManager.getEntries().some((entry) => entry.type === 'compaction')).toBe(
      true,
    );

    const branchAgent = await PiConductorAgent.create(createOptions());
    agents.push(branchAgent);
    const branchSession = getSession(branchAgent);
    const firstUserId = branchSession.sessionManager.appendMessage({
      role: 'user',
      content: [{ type: 'text', text: 'branch root request' }],
      timestamp: Date.now(),
    });
    branchSession.sessionManager.appendMessage({
      role: 'assistant',
      content: [{ type: 'text', text: 'branch root response' }],
      api: 'openai-completions',
      provider: 'fixture',
      model: 'fixture-model',
      usage: {
        input: 1,
        output: 1,
        cacheRead: 0,
        cacheWrite: 0,
        totalTokens: 2,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
      },
      stopReason: 'stop',
      timestamp: Date.now(),
    });
    branchSession.sessionManager.appendMessage({
      role: 'user',
      content: [{ type: 'text', text: 'branch abandoned request' }],
      timestamp: Date.now(),
    });
    branchSession.sessionManager.appendMessage({
      role: 'assistant',
      content: [{ type: 'text', text: 'branch abandoned response' }],
      api: 'openai-completions',
      provider: 'fixture',
      model: 'fixture-model',
      usage: {
        input: 1,
        output: 1,
        cacheRead: 0,
        cacheWrite: 0,
        totalTokens: 2,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
      },
      stopReason: 'stop',
      timestamp: Date.now(),
    });

    await branchSession.navigateTree(firstUserId, { summarize: true });
    expect(streamSimple).toHaveBeenCalled();
    expect(
      branchSession.sessionManager.getEntries().some((entry) => entry.type === 'branch_summary'),
    ).toBe(true);
  });
});
