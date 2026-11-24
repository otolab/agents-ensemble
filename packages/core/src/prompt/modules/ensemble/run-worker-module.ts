import type { PromptModule } from '@modular-prompt/core';

/** `ensemble run` worker 向けの記録先と手順。 */
export const runWorkerModule: PromptModule = {
  instructions: [
    '- 気づき・違和感・未解決は解決できなくても Notes に残す。書き先の note は conductor の指示に従う',
    '- `ensemble notes list` で一覧を確認し、`ensemble notes show <noteId>` で読む',
    '- `printf \'%s\\n\' \'記録する内容\' | ensemble notes push --note <noteId>` で本文を stdin から追記する。conductor の指示があれば `ensemble notes create --summary \'要約\'` で note を作成できる',
    '- 作業場 slug は環境変数から自動で解決されるため、`--slug` の指定は不要',
    '- サンドボックスなどの権限により Notes に書き込めない場合は、conductor に相談する',
  ],
};
