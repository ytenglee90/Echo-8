import type { PluginManifest, UISlot } from './contracts.ts';

export const KNOWN_PERMISSIONS = new Set([
  'store.own.read',
  'store.own.write',
  'ui.welcome.contribute',
  'ui.top.contribute',
  'ui.context.contribute',
  'ui.left.contribute',
  'ui.canvas.contribute',
  'ui.ai-settings.contribute',
  'ui.right.contribute',
  'ui.editor.contribute',
  'ui.status.contribute',
  'ui.overlay.contribute',
  'ui.modal.contribute',
  'ui.command-palette.contribute',
  'ui.action.register',
  'ui.action.execute',
  'ui.shortcut.register',
  'ui.shortcut.override',
  'ui.theme.manage',
  'plugins.lifecycle.manage',
  'history.manage',
  'persistence.manage',
  'preferences.manage',
  'personal.assets.manage',
  'content.context.read',
  'tasks.schedule',
  'workers.run',
  'network.ai.generate',
  'network.ai.embed',
  'network.ai.model',
  'network.cloud.sync',
  'network.origin.manage',
]);

const SLOT_PERMISSIONS: Record<UISlot, string> = {
  'application.welcome': 'ui.welcome.contribute',
  'top.primary': 'ui.top.contribute',
  'top.contextual': 'ui.context.contribute',
  'left.tools': 'ui.left.contribute',
  'canvas.background': 'ui.canvas.contribute',
  'canvas.empty': 'ui.canvas.contribute',
  'canvas.entities': 'ui.canvas.contribute',
  'canvas.groups': 'ui.canvas.contribute',
  'canvas.content': 'ui.canvas.contribute',
  'canvas.connections': 'ui.canvas.contribute',
  'canvas.selection': 'ui.canvas.contribute',
  'ai.settings': 'ui.ai-settings.contribute',
  'ai.retrieval': 'ui.ai-settings.contribute',
  'right.primary': 'ui.right.contribute',
  'right.editor': 'ui.editor.contribute',
  'bottom.status': 'ui.status.contribute',
  'overlay.floating': 'ui.overlay.contribute',
  'overlay.modal': 'ui.modal.contribute',
  'editor.immersive.overlay': 'ui.modal.contribute',
  'command.palette': 'ui.command-palette.contribute',
};

const COMMAND_PERMISSIONS: Record<string, string> = {
  'plugin.start': 'plugins.lifecycle.manage',
  'plugin.pause': 'plugins.lifecycle.manage',
  'plugin.stop': 'plugins.lifecycle.manage',
  'plugin.uninstall': 'plugins.lifecycle.manage',
  'history.undo': 'history.manage',
  'history.redo': 'history.manage',
  'system.document.replace': 'persistence.manage',
  'system.document.new': 'persistence.manage',
  'system.persistence.checkpoint': 'persistence.manage',
  'system.persistence.setAutosaveInterval': 'persistence.manage',
  'system.preferences.set': 'preferences.manage',
  'system.personalAssets.set': 'personal.assets.manage',
  'system.recovery.restore': 'persistence.manage',
  'system.action.execute': 'ui.action.execute',
};

export function assertKnownPermissions(manifest: PluginManifest): void {
  for (const permission of manifest.permissions) {
    if (!KNOWN_PERMISSIONS.has(permission)) {
      throw new Error(`Plugin ${manifest.id} declares unknown permission ${permission}`);
    }
  }
}

export function hasPermission(manifest: PluginManifest, permission: string): boolean {
  return manifest.permissions.includes(permission);
}

export function assertPermission(manifest: PluginManifest, permission: string, operation: string): void {
  if (!hasPermission(manifest, permission)) {
    throw new Error(`Permission denied for ${manifest.id}: ${operation} requires ${permission}`);
  }
}

export function assertSlotPermission(manifest: PluginManifest, slot: UISlot): void {
  assertPermission(manifest, SLOT_PERMISSIONS[slot], `contribute to ${slot}`);
}

export function hasCommandPermission(manifest: PluginManifest, type: string): boolean {
  const permission = COMMAND_PERMISSIONS[type];
  return permission === undefined || hasPermission(manifest, permission);
}

export function assertCommandPermission(manifest: PluginManifest, type: string): void {
  const permission = COMMAND_PERMISSIONS[type];
  if (permission) assertPermission(manifest, permission, `dispatch ${type}`);
}

export function assertCapabilityPermission(manifest: PluginManifest, key: string): void {
  if (key.startsWith('context.')) {
    assertPermission(manifest, 'content.context.read', `request ${key}`);
  }
}
