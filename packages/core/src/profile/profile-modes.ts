import type { ProfileMode } from './types.js';

/** 未指定は undefined。指定された値は両方の読み取り経路で同じ規則で検証する。 */
export function parseProfileModes(value: unknown, label: string): ProfileMode[] | undefined {
  if (value === undefined) return undefined;
  if (
    !Array.isArray(value) ||
    value.length === 0 ||
    value.some((mode) => mode !== 'issue' && mode !== 'run') ||
    new Set(value).size !== value.length
  ) {
    throw new Error(`Invalid profile ${label}: meta.modes must be a non-empty array of unique issue / run values`);
  }
  return value as ProfileMode[];
}
