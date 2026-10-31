export function removeOwnKeysInPlace(value: unknown, keys: readonly string[]): boolean {
  if (!isRecord(value)) return false;
  let changed = false;
  for (const key of keys) {
    if (!Object.prototype.hasOwnProperty.call(value, key)) continue;
    delete value[key];
    changed = true;
  }
  return changed;
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
