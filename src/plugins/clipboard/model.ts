import { createId, isRecord, type PluginDefinition } from '../../core/contracts.ts';
import type {
  ClipboardBundle,
  ClipboardFragment,
  ClipboardInstantiatePlan,
} from '../../protocols/clipboard.ts';
import type { SelectionResolution, SelectionSnapshot } from '../../protocols/selection.ts';
import { defineManifest } from '../manifest.ts';

const CLIPBOARD_NAMESPACE = 'clipboard';
const BUNDLE_KEY = 'bundle';

interface ClipboardCopiedEvent {
  cut: boolean;
}

interface ClipboardPastedEvent {
  selectIds: string[];
}

export function createClipboardPlugin(actionsView?: unknown): PluginDefinition {
  let pasteSerial = 0;
  return {
    manifest: defineManifest('clipboard', '内部剪贴板', {
      namespaces: [CLIPBOARD_NAMESPACE],
      namespaceDomains: { [CLIPBOARD_NAMESPACE]: 'workspace' },
      requiresCapabilities: ['selection.read@1', 'selection.resolve@1'],
      optionalCapabilities: ['clipboard.serialize@1', 'clipboard.instantiate@1'],
      providesCapabilities: ['clipboard.state@1'],
      commands: ['clipboard.copy', 'clipboard.cut', 'clipboard.paste', 'clipboard.duplicateSelectionAt'],
      dispatches: ['selection.delete', 'selection.set'],
      events: ['clipboard.copied', 'clipboard.pasted'],
      ui: ['clipboard.actions'],
      actions: ['clipboard.copy-action', 'clipboard.cut-action', 'clipboard.paste-action'],
      shortcuts: ['clipboard.copy-shortcut', 'clipboard.cut-shortcut', 'clipboard.paste-shortcut'],
      permissions: [
        'store.own.read',
        'store.own.write',
        'ui.top.contribute',
        'ui.action.register',
        'ui.shortcut.register',
      ],
    }),

    start(context) {
      pasteSerial = 0;
      const readBundle = () =>
        context.store.readValue<ClipboardBundle>(CLIPBOARD_NAMESPACE, BUNDLE_KEY);

      const readSelectionBundle = async (): Promise<ClipboardBundle> => {
        const selection = await context.capabilities.request<SelectionSnapshot>('selection.read@1');
        if (selection.ids.length === 0) throw new Error('没有可复制的选中项');
        const resolution = await context.capabilities.request<SelectionResolution>(
          'selection.resolve@1',
          { items: selection.items, mode: 'replace' },
        );
        const fragments = (await context.capabilities.requestAll<ClipboardFragment>(
          'clipboard.serialize@1',
          { ids: resolution.expandedIds },
        )).filter((fragment) => fragment.entityIds.length > 0);
        if (fragments.length === 0) throw new Error('选中项没有可复制的数据提供者');
        const textFragment = fragments.find((fragment) => fragment.owner === 'text-node');
        const plainTextPreview =
          textFragment && isRecord(textFragment.payload) && typeof textFragment.payload.plainTextPreview === 'string'
            ? textFragment.payload.plainTextPreview
            : '';
        return {
          format: 'application/x-echo-8-canvas+json',
          version: 1,
          copiedAt: Date.now(),
          sourceIds: selection.ids,
          fragments,
          plainTextPreview,
        };
      };

      const instantiate = async (
        bundle: ClipboardBundle,
        offset: { x: number; y: number },
        label: string,
      ) => {
        const sourceEntityIds = [...new Set(bundle.fragments.flatMap((fragment) => fragment.entityIds))];
        const idMap = Object.fromEntries(
          sourceEntityIds.map((id) => [id, createId(id.split(':')[0] || 'entity')]),
        );
        const plans = await context.capabilities.requestAll<ClipboardInstantiatePlan>(
          'clipboard.instantiate@1',
          { fragments: bundle.fragments, idMap, offset },
        );
        const patches = plans.flatMap((plan) => plan.patches);
        const selectIds = [...new Set(plans.flatMap((plan) => plan.selectIds ?? []))];
        if (patches.length === 0) throw new Error('当前插件组合无法复制这份内容');
        return {
          result: { created: selectIds.length },
          transaction: {
            label,
            patches,
            events: [
              ...plans.flatMap((plan) => plan.events ?? []),
              { type: 'clipboard.pasted', payload: { selectIds } satisfies ClipboardPastedEvent },
            ],
          },
        };
      };

      const copy = async (cut: boolean) => {
        const bundle = await readSelectionBundle();
        pasteSerial = 0;
        return {
          result: { count: bundle.sourceIds.length },
          transaction: {
            label: cut ? '剪切到内部剪贴板' : '复制到内部剪贴板',
            history: false,
            patches: [
              {
                op: 'set' as const,
                domain: 'workspace' as const,
                namespace: CLIPBOARD_NAMESPACE,
                key: BUNDLE_KEY,
                value: bundle,
              },
            ],
            events: [{ type: 'clipboard.copied', payload: { cut } satisfies ClipboardCopiedEvent }],
          },
        };
      };

      context.commands.register({
        type: 'clipboard.copy',
        handle: () => copy(false),
      });
      context.commands.register({
        type: 'clipboard.cut',
        handle: () => copy(true),
      });
      context.commands.register({
        type: 'clipboard.paste',
        handle: async () => {
          const bundle = readBundle();
          if (!bundle || bundle.version !== 1) throw new Error('内部剪贴板为空或版本不兼容');
          pasteSerial += 1;
          const offset = { x: pasteSerial * 36, y: pasteSerial * 36 };
          return instantiate(bundle, offset, '粘贴选中项');
        },
      });
      context.commands.register<{ offset: { x: number; y: number } }>({
        type: 'clipboard.duplicateSelectionAt',
        validate: (payload): payload is { offset: { x: number; y: number } } =>
          isRecord(payload) && isRecord(payload.offset) &&
          Number.isFinite(payload.offset.x) && Number.isFinite(payload.offset.y),
        handle: async ({ offset }) => instantiate(
          await readSelectionBundle(),
          offset,
          'Alt 拖拽复制选中项',
        ),
      });

      context.events.subscribe<ClipboardCopiedEvent>('clipboard.copied', (message) => {
        if (message.payload.cut) void context.commands.dispatch('selection.delete');
      });
      context.events.subscribe<ClipboardPastedEvent>('clipboard.pasted', (message) => {
        if (message.payload.selectIds.length > 0) {
          void context.commands.dispatch('selection.set', {
            ids: message.payload.selectIds,
            mode: 'replace',
          });
        }
      });

      context.capabilities.provide({
        key: 'clipboard.state@1',
        invoke: () => {
          const bundle = readBundle();
          return {
            hasContent: Boolean(bundle),
            copiedAt: bundle?.copiedAt,
            count: bundle?.sourceIds.length ?? 0,
            plainTextPreview: bundle?.plainTextPreview ?? '',
          };
        },
      });

      context.ui.contribute({
        id: 'clipboard.actions',
        slot: 'top.primary',
        kind: 'view',
        label: '剪贴板操作',
        group: 'clipboard',
        component: actionsView,
        priority: 30,
      });
      context.ui.shortcut({
        id: 'clipboard.copy-shortcut',
        chord: 'mod+c',
        command: 'clipboard.copy',
        label: '复制选中项',
      });
      context.ui.shortcut({
        id: 'clipboard.cut-shortcut',
        chord: 'mod+x',
        command: 'clipboard.cut',
        label: '剪切选中项',
      });
      context.ui.shortcut({
        id: 'clipboard.paste-shortcut',
        chord: 'mod+v',
        command: 'clipboard.paste',
        label: '粘贴',
      });
      context.ui.action({
        id: 'clipboard.copy-action',
        label: '复制选中项',
        command: 'clipboard.copy',
        category: '编辑',
        keywords: ['复制', 'copy'],
        priority: 70,
      });
      context.ui.action({
        id: 'clipboard.cut-action',
        label: '剪切选中项',
        command: 'clipboard.cut',
        category: '编辑',
        keywords: ['剪切', 'cut'],
        priority: 71,
      });
      context.ui.action({
        id: 'clipboard.paste-action',
        label: '粘贴',
        command: 'clipboard.paste',
        category: '编辑',
        keywords: ['粘贴', 'paste'],
        priority: 72,
      });
    },
  };
}
