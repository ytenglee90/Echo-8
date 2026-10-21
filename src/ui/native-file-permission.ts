/**
 * A persisted File System Access handle may outlive its browser permission.
 * Startup code may inspect permission, but only a fresh user gesture may ask
 * for it. Treat adapters without queryPermission as untrusted for background
 * reuse; explicit picker/import commands can still use them normally.
 */
export async function canReusePersistedFileHandle(
  target: { queryPermission?(descriptor?: { mode?: 'read' | 'readwrite' }): Promise<PermissionState> },
  mode: 'read' | 'readwrite' = 'readwrite',
): Promise<boolean> {
  if (!target.queryPermission) return false;
  try {
    return await target.queryPermission({ mode }) === 'granted';
  } catch {
    return false;
  }
}
