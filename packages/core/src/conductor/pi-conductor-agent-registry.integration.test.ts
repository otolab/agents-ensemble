import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, describe, expect, it } from 'vitest';
import {
  AssistantMessageEventStream,
  registerApiProvider,
  unregisterApiProviders,
  type AssistantMessage,
  type Context,
  type Model,
  type SimpleStreamOptions,
} from '@earendil-works/pi-ai/compat';
import {
  registerOAuthProvider,
  unregisterOAuthProvider,
  type OAuthCredentials,
} from '@earendil-works/pi-ai/oauth';
import { PiConductorAgent } from './pi-conductor-agent.js';

const STUB_PROVIDER = 'stub-oauth';
const STUB_API = 'stub-oauth-api';
const STUB_SOURCE = 'agents-ensemble-test-stub-oauth';

const requestCalls: Array<{
  model: Model<any>;
  options: SimpleStreamOptions | undefined;
}> = [];
let refreshCount = 0;

function stubStream(
  model: Model<any>,
  _context: Context,
  options?: SimpleStreamOptions,
): AssistantMessageEventStream {
  requestCalls.push({ model: { ...model }, options });
  const stream = new AssistantMessageEventStream();
  const message: AssistantMessage = {
    role: 'assistant',
    content: [{ type: 'text', text: 'stub response' }],
    api: STUB_API,
    provider: model.provider,
    model: model.id,
    usage: {
      input: 1,
      output: 1,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 2,
      cost: {
        input: 0,
        output: 0,
        cacheRead: 0,
        cacheWrite: 0,
        total: 0,
      },
    },
    stopReason: 'stop',
    timestamp: Date.now(),
  };
  queueMicrotask(() => {
    stream.push({ type: 'start', partial: message });
    stream.push({ type: 'done', reason: 'stop', message });
    stream.end();
  });
  return stream;
}

function registerStubProvider(): void {
  registerOAuthProvider({
    id: STUB_PROVIDER,
    name: 'Stub OAuth',
    login: async () => ({
      access: 'logged-in-key',
      refresh: 'refresh-token',
      expires: Date.now() + 60_000,
    }),
    refreshToken: async (credentials: OAuthCredentials) => {
      refreshCount += 1;
      return {
        ...credentials,
        access: 'refreshed-key',
        expires: Date.now() + 60_000,
      };
    },
    getApiKey: (credentials: OAuthCredentials) => credentials.access,
    modifyModels: (models) =>
      models.map((model) =>
        model.provider === STUB_PROVIDER
          ? {
              ...model,
              baseUrl: 'https://stub.example/registry',
              headers: { 'X-Stub-Provider': 'registry' },
            }
          : model,
      ),
  });
  registerApiProvider(
    {
      api: STUB_API,
      stream: stubStream,
      streamSimple: stubStream,
    },
    STUB_SOURCE,
  );
}

afterEach(() => {
  unregisterOAuthProvider(STUB_PROVIDER);
  unregisterApiProviders(STUB_SOURCE);
  requestCalls.length = 0;
  refreshCount = 0;
});

describe('PiConductorAgent ModelRegistry request auth', () => {
  it('passes refreshed OAuth key and registry model headers/base URL to the provider request', async () => {
    registerStubProvider();
    const cwd = await mkdtemp(join(tmpdir(), 'pi-registry-project-'));
    const agentDir = join(cwd, 'user-pi');
    const projectDir = join(cwd, 'project-pi');
    await mkdir(agentDir, { recursive: true });
    await mkdir(projectDir, { recursive: true });
    await writeFile(
      join(agentDir, 'auth.json'),
      JSON.stringify({
        [STUB_PROVIDER]: {
          type: 'oauth',
          access: 'expired-key',
          refresh: 'refresh-token',
          expires: 0,
        },
      }),
    );
    await writeFile(
      join(agentDir, 'models.json'),
      JSON.stringify({
        providers: {
          [STUB_PROVIDER]: {
            api: STUB_API,
            baseUrl: 'https://stub.example/initial',
            models: [
              {
                id: 'stub-model',
                name: 'Stub OAuth model',
                reasoning: false,
                input: ['text'],
                cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
                contextWindow: 128_000,
                maxTokens: 1_024,
              },
            ],
          },
        },
      }),
    );

    const conductor = await PiConductorAgent.create({
      cwd,
      pi: { agentDir, projectDir },
      modelId: `${STUB_PROVIDER}/stub-model`,
      systemPrompt: 'system',
    });

    const result = await conductor.send('hello');
    await conductor.close();

    expect(result).toMatchObject({ status: 'finished', result: 'stub response' });
    expect(refreshCount).toBeGreaterThan(0);
    expect(requestCalls).toHaveLength(1);
    expect(requestCalls[0]).toMatchObject({
      model: {
        provider: STUB_PROVIDER,
        id: 'stub-model',
        baseUrl: 'https://stub.example/registry',
        headers: { 'X-Stub-Provider': 'registry' },
      },
      options: { apiKey: 'refreshed-key' },
    });
    await expect(readFile(join(agentDir, 'auth.json'), 'utf8')).resolves.toContain(
      'refreshed-key',
    );
  });
});
