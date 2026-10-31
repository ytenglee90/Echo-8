const SAFE_START_QUERY = 'echo8-safe-start';

export function subscribeSafeStart(): () => void {
  return () => undefined;
}

export function getSafeStartServerSnapshot(): boolean {
  return false;
}

export function isSafeStartRequested(locationHref?: string): boolean {
  try {
    const href = locationHref ?? globalThis.location?.href;
    return href ? new URL(href).searchParams.get(SAFE_START_QUERY) === '1' : false;
  } catch {
    return false;
  }
}

export function reloadWithSafeStart(enabled: boolean): void {
  const current = globalThis.location.href;
  const target = new URL(current);
  if (enabled) target.searchParams.set(SAFE_START_QUERY, '1');
  else target.searchParams.delete(SAFE_START_QUERY);
  if (target.href === current) globalThis.location.reload();
  else globalThis.location.replace(target.href);
}
