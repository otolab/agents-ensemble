import type { OpenQuestion, WorkerDisplayStatus } from '@agents-ensemble/core';

export type { WorkerDisplayStatus };

export interface WorkerDisplayState {
  kind: string;
  status: WorkerDisplayStatus;
  /** processing 中の活動ヒント（例: `calling: Shell`）。 */
  activity?: string;
}

export interface DispatchHoldDisplayState {
  hold: boolean;
  heldEventCount: number;
}

/** #54 最小 UI の表示ペイン用 state（入力欄は含めない）。 */
export interface SessionDisplayState {
  workers: Record<string, WorkerDisplayState>;
  conductorOutput: string | null;
  openQuestions: OpenQuestion[];
  dispatchHold: DispatchHoldDisplayState;
}

export const INITIAL_SESSION_DISPLAY_STATE: SessionDisplayState = {
  workers: {},
  conductorOutput: null,
  openQuestions: [],
  dispatchHold: {
    hold: false,
    heldEventCount: 0,
  },
};
