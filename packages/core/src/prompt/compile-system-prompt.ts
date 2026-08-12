import { compile } from '@modular-prompt/core';
import type { IssueContext } from '../github/issue-context.js';
import type { Profile } from '../profile/types.js';
import { ensembleContext } from './contexts/kind.js';
import { sessionStateFromProfile } from '../profile/types.js';
import { renderCompiledPrompt } from './render-compiled-prompt.js';
import { mergeConductorSystemPrompt } from './modules/ensemble/index.js';
import { profilePromptModule } from './modules/shared/profile-prompt-module.js';
import { issueContextMaterial } from './issue-context-material.js';

export interface CompileConductorSystemPromptOptions {
  issueUrl: string;
  profile: Pick<Profile, 'workers' | 'agents' | 'materials'>;
  roleBootstrap?: string;
  /** 初回 send 用。Prepared Materials の Issue context として載せる。 */
  issueContext?: IssueContext;
}

/** conductor の system prompt（Instructions のみ。profile は merge で追記）。 */
export function compileConductorSystemPrompt(
  options: CompileConductorSystemPromptOptions,
): string {
  const sessionState = sessionStateFromProfile(options.profile);
  const profileMaterials = sessionState.materials ?? [];
  const materials = options.issueContext
    ? [issueContextMaterial(options.issueContext), ...profileMaterials]
    : profileMaterials;
  const profileModule = profilePromptModule({
    roleBootstrap: options.roleBootstrap,
    materials,
  });
  return renderCompiledPrompt(
    compile(
      mergeConductorSystemPrompt(profileModule),
      ensembleContext('conductor', options.issueUrl, sessionState),
    ),
  );
}
