import { compileConductorTurnUpdate } from '../conductor/prompt/compile-conductor-prompt.js';
import type { IssueContext } from '../github/issue-context.js';

export interface BuildHumanGuidancePromptOptions {
  guidance: string;
  repoRoot: string;
  issueContext: IssueContext;
}

export function buildHumanGuidancePrompt(
  options: BuildHumanGuidancePromptOptions | string,
): string {
  const resolved =
    typeof options === 'string'
      ? {
          guidance: options,
          repoRoot: '',
          issueContext: emptyIssueContext(),
        }
      : options;

  return compileConductorTurnUpdate({
    repoRoot: resolved.repoRoot,
    issueContext: resolved.issueContext,
    humanGuidance: resolved.guidance.trim(),
  });
}

function emptyIssueContext(): IssueContext {
  return {
    issue: { owner: '', repo: '', number: 0, url: '' },
    title: '',
    body: '',
    state: '',
    labels: [],
    comments: [],
  };
}
