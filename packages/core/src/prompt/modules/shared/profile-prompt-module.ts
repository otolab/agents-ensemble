import type { PromptModule, SubSectionElement } from '@modular-prompt/core';
import type { ResolvedProfileMaterial } from '../../../profile/types.js';

export interface ProfilePromptModuleInput {
  /** profile の `agents.<kind>.systemPromptFile` 本文。 */
  roleBootstrap?: string;
  /** load 済みの profile materials。 */
  materials?: ResolvedProfileMaterial[];
}

const MATERIALS_INSTRUCTION =
  '- Prepared Materials に載った profile 定義文書は、行動時の定義として読み、従う';

/** profile 起動文書と materials を modular-prompt モジュールに変換する。 */
export function profilePromptModule(
  input: ProfilePromptModuleInput,
): PromptModule | undefined {
  const roleBootstrap = input.roleBootstrap?.trim();
  const materialElements = toMaterialSubsections(input.materials ?? []);

  if (!roleBootstrap && materialElements.length === 0) {
    return undefined;
  }

  const instructions: string[] = [];
  if (roleBootstrap) {
    instructions.push(roleBootstrap);
  }
  if (materialElements.length > 0) {
    instructions.push(MATERIALS_INSTRUCTION);
  }

  return {
    ...(instructions.length > 0 ? { instructions } : {}),
    ...(materialElements.length > 0 ? { materials: materialElements } : {}),
  };
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
