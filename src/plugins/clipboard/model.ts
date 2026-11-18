import {
  createId,
  isRecord,
  type PluginDefinition,
  type RetiredDataScrubRule,
} from '../../core/contracts.ts';
import { isRecord as isPlainRecord, removeOwnKeysInPlace } from '../../services/retired-data.ts';
import {
  isClipboardCopySelectionRequest,
  isClipboardCapturedPasteRequest,
  isClipboardDuplicateRequest,
  type ClipboardBundle,
  type ClipboardCopySelectionRequest,
  type ClipboardFragment,
  type ClipboardInstantiatePlan,
} from '../../protocols/clipboard.ts';
import type { EntityDeletePlan, SelectionCatalogContribution, SelectionResolution, SelectionSnapshot } from '../../protocols/selection.ts';
import { defineManifest } from '../manifest.ts';

const CLIPBOARD_NAMESPACE = 'clipboard';
const BUNDLE_KEY = 'bundle';

export const CLIPBOARD_RETIRED_DATA: RetiredDataScrubRule = {
  id: 'clipboard.remove-retired-text-node-private-v1',
  namespace: CLIPBOARD_NAMESPACE,
  scrubInPlace(value) {
    if (!isPlainRecord(value) || !Array.isArray(value.fragments)) return false;
    let changed = false;
    for (const fragment of value.fragments) {
      if (!isPlainRecord(fragment) || fragment.owner !== 'text-node' ||
        !isPlainRecord(fragment.payload) || !Array.isArray(fragment.payload.nodes)) continue;
      for (const entry of fragment.payload.nodes) {
        if (!isPlainRecord(entry) || !isPlainRecord(entry.node)) continue;
        changed = removeOwnKeysInPlace(entry.node, ['private']) || changed;
      }
    }
    return changed;
  },
};

interface ClipboardCopiedEvent {
  cut: boolean;
  deleted?: true;
}

interface ClipboardPastedEvent {
  selectIds: string[];
}

export function createClipboardPlugin(actionsView?: unknown): PluginDefinition {
  let pasteSerial = 0;
  return {
    retiredDataScrubbers: [CLIPBOARD_RETIRED_DATA],
    manifest: defineManifest('clipboard', '内部剪贴板', {
      namespaces: [CLIPBOARD_NAMESPACE],
      namespaceDomains: { [CLIPBOARD_NAMESPACE]: 'workspace' },
      sessionOnlyWorkspace: { [CLIPBOARD_NAMESPACE]: true },
      requiresCapabilities: ['selection.read@1', 'selection.resolve@1'],
      optionalCapabilities: ['clipboard.serialize@1', 'clipboard.instantiate@1', 'entity.deletePlan@1', 'selection.entities@1', 'connections.graph@1'],
      providesCapabilities: ['clipboard.state@1', 'clipboard.sources@1'],
      commands: ['clipboard.copy', 'clipboard.copySelection@1', 'clipboard.cutSelection@1', 'clipboard.pasteCaptured@1', 'clipboard.duplicateCaptured@1', 'clipboard.cut', 'clipboard.paste', 'clipboard.duplicateSelectionAt'],
      dispatches: ['selection.delete', 'selection.set'],
      events: ['clipboard.copied', 'clipboard.pasted', 'entity.deleted'],
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

      const readSelectionBundle = async (captured?: ClipboardCopySelectionRequest): Promise<ClipboardBundle> => {
        const selection = captured ? undefined : await context.capabilities.request<SelectionSnapshot>('selection.read@1');
        const sourceIds = captured?.sourceIds ?? selection!.ids;
        if (sourceIds.length === 0) throw new Error('没有可复制的选中项');
        const resolution = await context.capabilities.request<SelectionResolution>(
          'selection.resolve@1',
          captured ? { ids: sourceIds, mode: 'replace' } : { items: selection!.items, mode: 'replace' },
        );
        if (captured && resolution.ids.length !== sourceIds.length) throw new Error('发送时的选区包含已失效的对象，请重新选中。');
        if (captured?.expectedKind && resolution.items.some(item => item.kind !== captured.expectedKind)) {
          throw new Error('发送时的选区包含其他类型，请选中指令指定的对象类型。');
        }
        const fragments = (await context.capabilities.requestAll<ClipboardFragment>(
          'clipboard.serialize@1',
          { ids: resolution.expandedIds },
        )).filter((fragment) => fragment.entityIds.length > 0);
        if (fragments.length === 0) throw new Error('选中项没有可复制的数据提供者');
        if (captured) {
          const copied = new Set(fragments.flatMap(fragment => fragment.entityIds));
          if (sourceIds.some(id => !copied.has(id))) throw new Error('部分发送时选中的对象不能单独复制。');
        }
        const textFragment = fragments.find((fragment) => fragment.owner === 'text-node');
        const plainTextPreview =
          textFragment && isRecord(textFragment.payload) && typeof textFragment.payload.plainTextPreview === 'string'
            ? textFragment.payload.plainTextPreview
            : '';
        return {
          format: 'application/x-echo-8-canvas+json',
          version: 1,
          copiedAt: Math.max(Date.now(), (readBundle()?.copiedAt ?? 0) + 1),
          sourceIds,
          fragments,
          plainTextPreview,
        };
      };

      const instantiate = async (
        bundle: ClipboardBundle,
        offset: { x: number; y: number },
        label: string,
        detailed = false,
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
        if (detailed) {
          const written = new Set(patches.filter(patch => patch.domain === 'document' && patch.op === 'set').map(patch => patch.key));
          if (Object.values(idMap).some(id => !written.has(id))) throw new Error('部分对象无法实例化，本次复制未提交。');
        }
        return {
          result: { created: selectIds.length, ...(detailed ? { createdIds: selectIds, entityIds: Object.values(idMap), sourceIds: [...bundle.sourceIds] } : {}) },
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

      const copy = async (cut: boolean, captured?: ClipboardCopySelectionRequest) => {
        const bundle = await readSelectionBundle(captured);
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
        type: 'clipboard.copySelection@1',
        validate: isClipboardCopySelectionRequest,
        handle: input => copy(false, input),
      });
      context.commands.register({
        type: 'clipboard.duplicateCaptured@1',
        validate: isClipboardDuplicateRequest,
        handle: async input => {
          if (input.includeInternalRelations) await context.capabilities.request('connections.graph@1');
          const bundle = await readSelectionBundle(input);
          let offset: { x: number; y: number };
          if ('offset' in input) offset = input.offset;
          else {
            const contributions = await context.capabilities.requestAll<SelectionCatalogContribution>('selection.entities@1');
            const entities = new Map<string, SelectionCatalogContribution['entities']>();
            const requested = new Set(input.sourceIds);
            for (const entity of contributions.flatMap(contribution => contribution.entities)) {
              if (requested.has(entity.id)) entities.set(entity.id, [...(entities.get(entity.id) ?? []), entity]);
            }
            const bounds = input.sourceIds.map(id => {
              const matches = entities.get(id) ?? [];
              const box = matches.length === 1 ? matches[0]!.bounds : undefined;
              if (!box || ![box.x, box.y, box.width, box.height].every(Number.isFinite) || box.width < 0 || box.height < 0) {
                throw new Error('复制对象缺少唯一的公开几何范围。');
              }
              return box;
            });
            const width = Math.max(...bounds.map(box => box.x + box.width)) - Math.min(...bounds.map(box => box.x));
            const height = Math.max(...bounds.map(box => box.y + box.height)) - Math.min(...bounds.map(box => box.y));
            const gap = input.gap ?? 80;
            offset = { x: input.direction === 'right' ? width + gap : input.direction === 'left' ? -width - gap : 0,
              y: input.direction === 'down' ? height + gap : input.direction === 'up' ? -height - gap : 0 };
          }
          return instantiate(bundle, offset, '复制明确对象及内部关系', true);
        },
      });
      context.commands.register({
        type: 'clipboard.cutSelection@1',
        validate: isClipboardCopySelectionRequest,
        handle: async input => {
          const resolution = await context.capabilities.request<SelectionResolution>('selection.resolve@1', { ids: input.sourceIds, mode: 'replace' });
          if (resolution.ids.length !== input.sourceIds.length) throw new Error('发送时的剪切对象已失效。');
          const plans = await context.capabilities.requestAll<EntityDeletePlan>('entity.deletePlan@1', {
            ids: resolution.expandedIds, items: resolution.items,
          });
          const patches = plans.flatMap(plan => plan.patches);
          if (patches.length === 0) throw new Error('发送时的对象当前无法剪切。');
          // The clipboard belongs to the workspace. Document deletion has its own undoable transaction.
          const copied = await context.commands.invoke('clipboard.copySelection@1', input);
          return { result: copied, transaction: {
            label: '剪切发送时选中的对象',
            patches,
            events: [...plans.flatMap(plan => plan.events ?? []),
              { type: 'entity.deleted', payload: { ids: resolution.expandedIds } },
              { type: 'clipboard.copied', payload: { cut: true, deleted: true } satisfies ClipboardCopiedEvent }],
          } };
        },
      });
      context.commands.register({
        type: 'clipboard.pasteCaptured@1',
        validate: isClipboardCapturedPasteRequest,
        handle: async input => {
          const bundle = readBundle();
          if (!bundle || bundle.version !== 1 || bundle.copiedAt !== input.copiedAt || bundle.sourceIds.length !== input.sourceIds.length ||
            bundle.sourceIds.some((id, index) => id !== input.sourceIds[index])) {
            throw new Error('发送后内部剪贴板已变化，请重新发送粘贴指令。');
          }
          pasteSerial += 1;
          return instantiate(bundle, { x: pasteSerial * 36, y: pasteSerial * 36 }, '粘贴已核对的剪贴板对象');
        },
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
        if (message.payload.cut && !message.payload.deleted) void context.commands.dispatch('selection.delete');
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
        key: 'clipboard.sources@1',
        invoke: () => {
          const bundle = readBundle();
          return { copiedAt: bundle?.copiedAt, sourceIds: [...(bundle?.sourceIds ?? [])] };
        },
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
        priority: 30,
      });
      context.ui.action({
        id: 'clipboard.cut-action',
        label: '剪切选中项',
        command: 'clipboard.cut',
        category: '编辑',
        keywords: ['剪切', 'cut'],
        priority: 40,
      });
      context.ui.action({
        id: 'clipboard.paste-action',
        label: '粘贴',
        command: 'clipboard.paste',
        category: '编辑',
        keywords: ['粘贴', 'paste'],
        priority: 50,
      });
    },
  };
}
