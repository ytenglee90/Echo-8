import {
  isRecord,
  type PluginDefinition,
  type RegisteredShortcut,
  type ShortcutOverride,
} from '../../core/contracts.ts';
import { defineManifest } from '../manifest.ts';
import type { ShortcutCenterState } from './types.ts';

export const SHORTCUT_CENTER_NAMESPACE = 'shortcutCenter';
const SHORTCUT_PREFERENCE_KEY = 'shortcut-center.overrides@1';

export function createShortcutCenterPlugin(panel?: unknown): PluginDefinition {
  return {
    manifest: defineManifest('shortcut-center', '快捷键中心', {
      namespaces: [SHORTCUT_CENTER_NAMESPACE],
      namespaceDomains: { [SHORTCUT_CENTER_NAMESPACE]: 'workspace' },
      commands: [
        'shortcuts.open',
        'shortcuts.close',
        'shortcuts.setOverride',
        'shortcuts.clearOverride',
        'shortcuts.resetOverride',
        'shortcuts.resetAll',
        'shortcuts.restorePreferences',
      ],
      dispatches: ['shortcuts.restorePreferences', 'system.preferences.set'],
      events: ['shortcuts.changed'],
      queries: ['shortcuts.state'],
      asks: ['shortcuts.state', 'system.shortcuts', 'system.actions', 'system.preferences.get'],
      ui: ['shortcut-center.panel'],
      actions: ['shortcut-center.open-action'],
      shortcuts: ['shortcut-center.open-shortcut', 'shortcut-center.close-shortcut'],
      permissions: [
        'store.own.read',
        'store.own.write',
        'ui.right.contribute',
        'ui.action.register',
        'ui.shortcut.register',
        'ui.shortcut.override',
        'preferences.manage',
      ],
    }),

    async start(context) {
      const readOverrides = () => normalizeStoredOverrides(
        context.store.readValue(SHORTCUT_CENTER_NAMESPACE, 'overrides'),
      );
      const readState = (): ShortcutCenterState => ({
        open: context.store.readValue<boolean>(SHORTCUT_CENTER_NAMESPACE, 'open') ?? false,
        overrides: readOverrides(),
      });
      const openTransaction = (open: boolean) => ({
        transaction: {
          label: open ? '打开快捷键中心' : '关闭快捷键中心',
          history: false,
          patches: [{
            op: 'set' as const,
            domain: 'workspace' as const,
            namespace: SHORTCUT_CENTER_NAMESPACE,
            key: 'open',
            value: open,
          }],
        },
      });
      const overridesTransaction = (label: string, overrides: ShortcutOverride[]) => ({
        result: { count: overrides.length },
        transaction: {
          label,
          history: false,
          patches: [{
            op: 'set' as const,
            domain: 'workspace' as const,
            namespace: SHORTCUT_CENTER_NAMESPACE,
            key: 'overrides',
            value: overrides,
          }],
          events: [{ type: 'shortcuts.changed', payload: { count: overrides.length } }],
        },
      });

      context.commands.register({
        type: 'shortcuts.open',
        handle: () => {
          context.ui.activateSurface('right.primary', 'shortcut-center.panel', 'shortcuts.close');
          return openTransaction(true);
        },
      });
      context.commands.register({
        type: 'shortcuts.close',
        handle: () => {
          context.ui.deactivateSurface('right.primary', 'shortcut-center.panel');
          return openTransaction(false);
        },
      });
      context.commands.register<ShortcutOverride, { count: number }>({
        type: 'shortcuts.setOverride',
        validate: isEnabledShortcutOverride,
        handle: async (payload) => {
          const available = await context.queries.ask<RegisteredShortcut[]>('system.shortcuts');
          if (!available.some((item) => item.owner === payload.targetOwner && item.id === payload.targetId)) {
            throw new Error('目标快捷键当前不可用');
          }
          const next = readOverrides().filter(
            (item) => item.targetOwner !== payload.targetOwner || item.targetId !== payload.targetId,
          );
          next.push(payload);
          const normalized = context.ui.validateShortcutOverrides(next);
          return overridesTransaction('修改快捷键', normalized);
        },
      });
      context.commands.register<{ targetOwner: string; targetId: string }, { count: number }>({
        type: 'shortcuts.clearOverride',
        validate: isShortcutTarget,
        handle: async (payload) => {
          const available = await context.queries.ask<RegisteredShortcut[]>('system.shortcuts');
          if (!available.some((item) => item.owner === payload.targetOwner && item.id === payload.targetId)) {
            throw new Error('目标快捷键当前不可用');
          }
          const next = readOverrides().filter(
            (item) => item.targetOwner !== payload.targetOwner || item.targetId !== payload.targetId,
          );
          next.push({ ...payload, disabled: true });
          const normalized = context.ui.validateShortcutOverrides(next);
          return overridesTransaction('清空快捷键', normalized);
        },
      });
      context.commands.register<{ targetOwner: string; targetId: string }, { count: number }>({
        type: 'shortcuts.resetOverride',
        validate: isShortcutTarget,
        handle: (payload) => overridesTransaction(
          '恢复默认快捷键',
          readOverrides().filter(
            (item) => item.targetOwner !== payload.targetOwner || item.targetId !== payload.targetId,
          ),
        ),
      });
      context.commands.register({
        type: 'shortcuts.resetAll',
        handle: () => overridesTransaction('恢复全部默认快捷键', []),
      });
      context.commands.register<{ overrides: ShortcutOverride[] }, { count: number }>({
        type: 'shortcuts.restorePreferences',
        validate: (payload): payload is { overrides: ShortcutOverride[] } => isRecord(payload) &&
          Array.isArray(payload.overrides) && payload.overrides.every(isStoredShortcutOverride),
        handle: (payload) => overridesTransaction(
          '恢复个人快捷键设置',
          context.ui.validateShortcutOverrides(payload.overrides),
        ),
      });
      context.events.subscribe('shortcuts.changed', () => {
        context.ui.shortcutOverrides(readOverrides());
        void Promise.resolve().then(() => context.commands.dispatch('system.preferences.set', {
            key: SHORTCUT_PREFERENCE_KEY,
            value: readOverrides(),
          })).catch((error) => {
          context.diagnostics.warn('快捷键个人设置暂时无法保存', error);
        });
      });
      context.queries.register({ type: 'shortcuts.state', handle: readState });

      context.ui.contribute({
        id: 'shortcut-center.panel',
        slot: 'right.primary',
        kind: 'view',
        label: '快捷键中心',
        component: panel,
        priority: 80,
      });
      if (readState().open) {
        context.ui.activateSurface('right.primary', 'shortcut-center.panel', 'shortcuts.close');
      }
      context.ui.action({
        id: 'shortcut-center.open-action',
        label: '打开快捷键中心',
        command: 'shortcuts.open',
        category: '系统',
        keywords: ['快捷键', '键盘', '冲突', 'shortcut'],
        priority: 80,
      });
      context.ui.shortcut({
        id: 'shortcut-center.open-shortcut',
        chord: 'mod+alt+k',
        command: 'shortcuts.open',
        label: '打开快捷键中心',
      });
      context.ui.shortcut({
        id: 'shortcut-center.close-shortcut',
        command: 'shortcuts.close',
        label: '关闭快捷键中心',
        category: '系统',
        allowInEditable: true,
      });

      try {
        const stored = await context.queries.ask<unknown>('system.preferences.get', {
          key: SHORTCUT_PREFERENCE_KEY,
        });
        if (stored !== undefined) {
          await context.commands.dispatch('shortcuts.restorePreferences', {
            overrides: normalizeStoredOverrides(stored),
          });
        } else if (readOverrides().length > 0) {
          await context.commands.dispatch('system.preferences.set', {
            key: SHORTCUT_PREFERENCE_KEY,
            value: readOverrides(),
          });
        }
        context.ui.shortcutOverrides(readOverrides());
      } catch (error) {
        context.diagnostics.warn('个人快捷键设置无法读取，已使用本次画布中的设置', error);
        try {
          context.ui.shortcutOverrides(readOverrides());
        } catch (overrideError) {
          context.diagnostics.warn('保存的快捷键覆盖与当前插件组合冲突，已临时使用默认值', overrideError);
          context.ui.shortcutOverrides([]);
        }
      }
    },
  };
}

function normalizeStoredOverrides(value: unknown): ShortcutOverride[] {
  if (!Array.isArray(value)) return [];
  return value.filter(isStoredShortcutOverride).map((item) => ({ ...item }));
}

function isEnabledShortcutOverride(value: unknown): value is ShortcutOverride {
  return isShortcutTarget(value) &&
    (value as { disabled?: unknown }).disabled !== true &&
    typeof (value as { chord?: unknown }).chord === 'string';
}

function isStoredShortcutOverride(value: unknown): value is ShortcutOverride {
  if (!isShortcutTarget(value)) return false;
  if ((value as { disabled?: unknown }).disabled === true) {
    const chord = (value as { chord?: unknown }).chord;
    return chord === undefined || chord === '';
  }
  return typeof (value as { chord?: unknown }).chord === 'string';
}

function isShortcutTarget(value: unknown): value is { targetOwner: string; targetId: string } {
  return isRecord(value) && typeof value.targetOwner === 'string' && typeof value.targetId === 'string';
}
