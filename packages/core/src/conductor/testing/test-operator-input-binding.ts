import type {
  OperatorInputBinding,
  OperatorInputBindingApi,
  OperatorInputContext,
} from '../operator-input-binding.js';

export interface TestOperatorInputBinding {
  bindOperatorInput: OperatorInputBinding;
  /** 現在の context に応じて `submit` を試みる。 */
  trySubmit: () => boolean;
  /** `onOpenQuestionEnqueued` にそのまま渡せる。 */
  onOpenQuestionEnqueued: () => void;
}

/**
 * テスト用: `bindOperatorInput` 経由でオペレータ入力をキューへ積む。
 * 旧 `onOperatorInput` の同期ポーリングを置き換える。
 */
export function createTestOperatorInputBinding(
  decide: (context: OperatorInputContext) => string | undefined,
  options?: { submitOnBind?: boolean },
): TestOperatorInputBinding {
  let api: OperatorInputBindingApi | undefined;
  const submitOnBind = options?.submitOnBind ?? true;

  const trySubmit = (): boolean => {
    if (!api) {
      return false;
    }
    const message = decide(api.getContext());
    if (!message?.trim()) {
      return false;
    }
    return api.submit(message.trim());
  };

  return {
    bindOperatorInput: (bindingApi) => {
      api = bindingApi;
      if (submitOnBind) {
        trySubmit();
      }
    },
    trySubmit,
    onOpenQuestionEnqueued: trySubmit,
  };
}
