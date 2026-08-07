import type { WorkerDispatchResult } from '../dispatch/worker-dispatch.js';
import { fetchIssueContext } from '../github/issue-context.js';
import { buildConductorPrompt } from './build-conductor-prompt.js';
import { ConductorAgent } from './conductor-agent.js';
import { createDispatchTools } from './dispatch-tools.js';

export interface RunIssueSessionOptions {
  issueUrl: string;
  repoRoot: string;
  conductorCwd?: string;
  briefing?: string;
  resumeAgentId?: string;
  apiKey?: string;
  modelId?: string;
  onWorkerDispatched?: (result: WorkerDispatchResult) => void;
}

export interface IssueSessionResult {
  agentId: string;
  issueUrl: string;
  repoRoot: string;
  lastRunStatus: string;
  lastResult?: string;
  workerDispatches: WorkerDispatchResult[];
}

export async function runIssueSession(
  options: RunIssueSessionOptions,
): Promise<IssueSessionResult> {
  const issueContext = await fetchIssueContext(options.issueUrl);
  const workerDispatches: WorkerDispatchResult[] = [];
  const dispatchTools = createDispatchTools({
    repoRoot: options.repoRoot,
    onWorkerDispatched: (result) => {
      workerDispatches.push(result);
      options.onWorkerDispatched?.(result);
    },
  });

  const conductorOptions = {
    cwd: options.conductorCwd ?? process.cwd(),
    apiKey: options.apiKey,
    modelId: options.modelId,
    customTools: dispatchTools,
  };

  const conductor = options.resumeAgentId
    ? await ConductorAgent.resume(options.resumeAgentId, conductorOptions)
    : await ConductorAgent.create(conductorOptions);

  try {
    const prompt = buildConductorPrompt({
      issueContext,
      repoRoot: options.repoRoot,
      briefing: options.briefing,
      followUp: options.resumeAgentId
        ? '前回の続きです。Issue / PR の最新状態を踏まえ、次に必要な dispatch を判断してください。'
        : undefined,
    });

    const sendResult = await conductor.send(prompt);

    return {
      agentId: conductor.agentId,
      issueUrl: options.issueUrl,
      repoRoot: options.repoRoot,
      lastRunStatus: sendResult.status,
      lastResult: sendResult.result,
      workerDispatches,
    };
  } finally {
    await conductor.close();
  }
}
