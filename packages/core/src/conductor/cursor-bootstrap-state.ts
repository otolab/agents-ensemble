export type CursorBootstrapStatus =
  | 'unknown'
  | 'saving'
  | 'complete'
  | 'incomplete';

export type CursorBootstrapAssumption =
  | 'assume-complete'
  | 'assume-incomplete';

/** Mutable only while an operator resolves a legacy Cursor session. */
export interface CursorBootstrapState {
  status: CursorBootstrapStatus;
  pendingAssumption?: CursorBootstrapAssumption;
}

export function cursorBootstrapCompleteForStore(
  state: CursorBootstrapState,
): boolean | undefined {
  if (state.status === 'unknown') return undefined;
  if (state.status === 'saving') {
    if (state.pendingAssumption === undefined) return undefined;
    return state.pendingAssumption === 'assume-complete';
  }
  return state.status === 'complete';
}
