import type { PromptModule } from '@modular-prompt/core';

/** Issue worker 固有の記録先と手順。 */
export const ticketWorkerModule: PromptModule = {
  instructions: [
    '- 手順の細部は Skill（指示があれば）と Issue / PR を source of truth とする',
    '- 気づき・違和感・未解決は解決できなくても Issue に残す',
  ],
};
