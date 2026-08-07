import type { PromptModule } from '@modular-prompt/core';

export const BOOTSTRAP_NOTE =
  'personaとfoundationモードを有効にしてください。本文をresourceから読み込むのも忘れずに。';

/** worker / reviewer 共通の起動準備。Instructions 系（preparationNote）。 */
export const bootstrapModule: PromptModule = {
  preparationNote: [BOOTSTRAP_NOTE],
};
