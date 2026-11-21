import { compile } from '@modular-prompt/core';
import type { PromptModule } from '@modular-prompt/core';
import type { ResolvedProfile, ResolvedProfileMaterial } from '../profile/types.js';
import {
  filterMaterialsForKind,
  sessionStateFromProfile,
} from '../profile/types.js';
import { workspaceEnsembleContext } from './contexts/workspace-kind.js';
import { renderCompiledPrompt } from './render-compiled-prompt.js';
import { mergeRunConductorSystemPrompt } from './modules/ensemble/run-ensemble-index.js';
import { profilePromptModule } from './modules/shared/profile-prompt-module.js';

export interface CompileWorkspaceConductorSystemPromptOptions {
  workspaceSlugKey: string;
  profile: Pick<ResolvedProfile, 'workers' | 'agents' | 'materials'>;
  agentModule?: PromptModule;
  userInstructions?: ResolvedProfileMaterial;
  /** `ensemble run <brief>` の本文。Prepared Materials として載せる。 */
  briefText?: string;
}

export function compileWorkspaceConductorSystemPrompt(
  options: CompileWorkspaceConductorSystemPromptOptions,
): string {
  const sessionState = sessionStateFromProfile(options.profile);
  const profileMaterials = filterMaterialsForKind(
    sessionState.materials,
    'conductor',
  );
  const materials: ResolvedProfileMaterial[] = [
  ...profileMaterials,
  ...(options.briefText
    ? [
        {
          id: 'run-brief',
          title: 'Brief',
          content: options.briefText,
          kinds: ['conductor'],
        },
      ]
    : []),
    ...(options.userInstructions ? [options.userInstructions] : []),
  ];
  const profileModule = profilePromptModule({
    agentModule: options.agentModule,
    materials,
  });
  return renderCompiledPrompt(
    compile(
      mergeRunConductorSystemPrompt(profileModule),
      workspaceEnsembleContext(
        'conductor',
        options.workspaceSlugKey,
        sessionState,
      ),
    ),
  );
}

export function createWorkspacePiKickoffPrompt(
  workspaceSlugKey: string,
  briefText?: string,
): string {
  const brief =
    briefText?.trim() ?
      ` Follow the brief in Prepared Materials.`
    : '';
  return (
    `Start the conductor workflow for workspace ${workspaceSlugKey}.${brief} ` +
    `Use Notes for durable summaries and timeline. Coordinate workers and escalate to the operator via open questions when needed.`
  );
}