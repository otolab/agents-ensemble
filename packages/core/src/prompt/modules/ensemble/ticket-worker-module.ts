import type { PromptModule } from '@modular-prompt/core';

/** Issue worker 固有の記録先と手順。 */
export const ticketWorkerModule: PromptModule = {
  instructions: [
    '- 手順の細部は Skill（指示があれば）と Issue / PR を source of truth とする',
    '- 気づき・違和感・未解決は解決できなくても Issue に残す',
    {
      type: 'subsection',
      title: 'codex-acpへのアドバイス',
      items: [
        '- サンドボックス内では認証エラーになるツールがあります(ghなど)が、conductorと相談の上、サンドボックス外での実行に切り替えてください',
        '- git addやcommitについても同様に権限エラーになる可能性があります。sandbox外実行を試し、失敗する場合はconductorに対して代行を依頼してください'
      ],
    },
  ],
};
