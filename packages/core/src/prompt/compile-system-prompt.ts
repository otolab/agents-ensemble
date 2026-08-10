import { compile } from '@modular-prompt/core';
import type { Profile } from '../profile/types.js';
import { ensembleContext } from './contexts/kind.js';
import { sessionStateFromProfile } from '../profile/types.js';
import { renderCompiledPrompt } from './render-compiled-prompt.js';
import { mergeConductorSystemPrompt } from './modules/ensemble/index.js';
import { profilePromptModule } from './modules/shared/profile-prompt-module.js';

export interface CompileConductorSystemPromptOptions {
  issueUrl: string;
  profile: Pick<Profile, 'workers' | 'agents' | 'materials'>;
  roleBootstrap?: string;
}

/** conductor の system prompt（Instructions のみ。profile は merge で追記）。 */
export function compileConductorSystemPrompt(
  options: CompileConductorSystemPromptOptions,
): string {
  const sessionState = sessionStateFromProfile(options.profile);
  const profileModule = profilePromptModule({
    roleBootstrap: options.roleBootstrap,
    materials: sessionState.materials,
  });
  return renderCompiledPrompt(
    compile(
      mergeConductorSystemPrompt(profileModule),
      ensembleContext('conductor', options.issueUrl, sessionState),
    ),
  );
}
