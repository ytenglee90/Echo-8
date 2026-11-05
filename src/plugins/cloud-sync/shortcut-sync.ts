import type { ShortcutOverride } from '../../core/contracts.ts';

export interface ShortcutAccountState {
  userId: string;
  revision: number;
  baseline: string;
  dirty: boolean;
}
export interface RemoteShortcuts { revision: number; overrides: ShortcutOverride[] }

export function shortcutFingerprint(overrides: ShortcutOverride[]): string {
  return JSON.stringify(overrides.map(item => ({ targetOwner: item.targetOwner, targetId: item.targetId,
    ...(item.disabled ? { disabled: true } : { chord: item.chord }) }))
    .sort((a, b) => a.targetOwner.localeCompare(b.targetOwner) || a.targetId.localeCompare(b.targetId)));
}

/** Never silently overwrite concurrent personal settings from a second device. */
export function planShortcutSync(userId: string, local: ShortcutOverride[], remote: RemoteShortcuts, saved?: ShortcutAccountState) {
  const current = shortcutFingerprint(local);
  const cloud = shortcutFingerprint(remote.overrides);
  const sameUser = saved?.userId === userId;
  const changedHere = sameUser && (saved.dirty || saved.baseline !== current);
  if (current === cloud) return { action: 'equal' as const, state: { userId, revision: remote.revision, baseline: current, dirty: false } };
  if (changedHere && remote.revision !== saved.revision) return { action: 'conflict' as const, state: { ...saved, dirty: true } };
  if (changedHere || remote.revision === 0 && local.length > 0 && (!saved || sameUser)) return {
    action: 'upload' as const, state: { userId, revision: remote.revision, baseline: current, dirty: true },
  };
  return { action: 'download' as const, state: { userId, revision: remote.revision, baseline: cloud, dirty: false } };
}
