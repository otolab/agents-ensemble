export const DEFAULT_POLL_INTERVAL_MS = 2_000;
export const MIN_POLL_INTERVAL_MS = 250;
export const MAX_POLL_INTERVAL_MS = 60_000;
export const MAX_DEBOUNCE_MS = 10_000;
export const DEFAULT_MESSAGE_DEBOUNCE_MS = 10_000;
export const MAX_MESSAGE_DEBOUNCE_MS = 120_000;

export function parseBoundedInteger(
  value: number | undefined,
  fallback: number,
  minimum: number,
  maximum: number,
  name: string,
): number {
  if (value === undefined) return fallback;
  if (!Number.isInteger(value) || value < minimum || value > maximum) {
    throw new Error(`${name} must be an integer from ${minimum} to ${maximum}.`);
  }
  return value;
}
