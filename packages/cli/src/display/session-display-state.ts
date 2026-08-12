import type { OpenQuestion } from '@agents-ensemble/core';

export type WorkerDisplayStatus = 'idle' | 'running' | 'failed';

export interface WorkerDisplayState {
  kind: string;
  status: WorkerDisplayStatus;
}

/** #54 最小 UI の表示ペイン用 state（入力欄は含めない）。 */
export interface SessionDisplayState {
  workers: Record<string, WorkerDisplayState>;
  conductorOutput: string | null;
  openQuestions: OpenQuestion[];
}

export const INITIAL_SESSION_DISPLAY_STATE: SessionDisplayState = {
  workers: {},
  conductorOutput: null,
  openQuestions: [],
};
