import { merge } from '@modular-prompt/core';
import type { PromptModule, SubSectionElement } from '@modular-prompt/core';
import type { ResolvedProfileMaterial } from '../../../profile/types.js';

export interface ProfilePromptModuleInput {
  /** profile の `agents.<kind>` から構築した PromptModule。 */
  agentModule?: PromptModule;
  /** load 済みの profile materials。 */
  materials?: ResolvedProfileMaterial[];
}

const MATERIALS_INSTRUCTION =
  '- Prepared Materials に載った profile 定義文書は、行動時の定義として読み、従う';

/** profile agent module と materials を modular-prompt モジュールに変換する。 */
export function profilePromptModule(
  input: ProfilePromptModuleInput,
): PromptModule | undefined {
  const materialElements = toMaterialSubsections(input.materials ?? []);
  const materialsModule: PromptModule | undefined =
    materialElements.length > 0
      ? {
          instructions: [MATERIALS_INSTRUCTION],
          materials: materialElements,
        }
      : undefined;

  if (!input.agentModule && !materialsModule) {
    return undefined;
  }

  if (!input.agentModule) {
    return materialsModule;
  }
  if (!materialsModule) {
    return input.agentModule;
  }
  return merge(input.agentModule, materialsModule);
}

function toMaterialSubsections(
  materials: ResolvedProfileMaterial[],
): SubSectionElement[] {
  return materials.map((material) => ({
    type: 'subsection' as const,
    title: material.title,
    items: [material.content],
  }));
}
