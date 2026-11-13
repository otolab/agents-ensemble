function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** プレーンオブジェクトを再帰的にマージする。override が user / project 層。 */
export function deepMerge<T extends Record<string, unknown>>(
  base: T,
  override: Record<string, unknown>,
): T {
  const result: Record<string, unknown> = { ...base };

  for (const [key, value] of Object.entries(override)) {
    if (value === undefined) {
      continue;
    }
    const existing = Object.hasOwn(result, key) ? result[key] : undefined;
    if (isPlainObject(existing) && isPlainObject(value)) {
      Object.defineProperty(result, key, {
        value: deepMerge(existing, value),
        enumerable: true,
        configurable: true,
        writable: true,
      });
      continue;
    }
    Object.defineProperty(result, key, {
      value,
      enumerable: true,
      configurable: true,
      writable: true,
    });
  }

  return result as T;
}
