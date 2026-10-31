import { isRecord, type PluginDefinition, type TransactionProposal } from '../../core/contracts.ts';
import type { CanvasPointerSnapshot } from '../../protocols/canvas.ts';
import type { ContentSummary } from '../../protocols/content.ts';
import type {
  EntityDeletePlan,
  SelectableEntity,
  SelectionAllPayload,
  SelectionCatalogContribution,
  SelectionBoxPayload,
  SelectionItem,
  SelectionMode,
  SelectionResolution,
  SelectionResolutionRequest,
  SelectionScopeAtRequest,
  SelectionScopeContribution,
  SelectionSetPayload,
  SelectionSnapshot,
} from '../../protocols/selection.ts';
import { defineManifest } from '../manifest.ts';
import { SelectionCatalogIndex } from './catalog-index.ts';

const SELECTION_NAMESPACE = 'selection';
const SELECTION_KEY = 'current';

interface StoredSelection {
  items: SelectionItem[];
}

export function createSelectionPlugin(selectionActions?: unknown): PluginDefinition {
  return {
    manifest: defineManifest('selection', '选择与批量操作', {
      category: 'core',
      namespaces: [SELECTION_NAMESPACE],
      namespaceDomains: { [SELECTION_NAMESPACE]: 'workspace' },
      sessionOnlyWorkspace: { [SELECTION_NAMESPACE]: true },
      requiresCapabilities: ['content.summaries@1'],
      optionalCapabilities: [
        'entity.deletePlan@1',
        'selection.entities@1',
        'selection.scopeAt@1',
        'canvas.pointer@1',
      ],
      providesCapabilities: ['selection.read@1', 'selection.resolve@1'],
      commands: [
        'selection.set',
        'selection.clear',
        'selection.box',
        'selection.all',
        'selection.delete',
      ],
      dispatches: ['canvas.focusSelection'],
      events: ['entity.deleted', 'history.changed', 'document.replaced'],
      signals: [
        'content.catalog.invalidated',
        'connections.invalidated',
        'groups.invalidated',
        'annotations.invalidated',
      ],
      ui: ['selection.actions', 'selection.delete-button'],
      actions: ['selection.all-action', 'selection.delete-action', 'selection.clear-action'],
      shortcuts: [
        'selection.all-shortcut', 'selection.delete-shortcut', 'selection.backspace-shortcut',
        'selection.clear-shortcut',
      ],
      permissions: [
        'store.own.read',
        'store.own.write',
        'ui.context.contribute',
        'ui.top.contribute',
        'ui.action.register',
        'ui.shortcut.register',
      ],
    }),

    start(context) {
      const catalog = new SelectionCatalogIndex();
      let catalogInvalidation = 1;
      let appliedCatalogInvalidation = 0;
      let catalogReady = false;
      let catalogRefresh: Promise<void> | undefined;

      const readSelection = (): SelectionSnapshot => {
        const stored = context.store.readValue<StoredSelection | string[]>(SELECTION_NAMESPACE, SELECTION_KEY);
        const items = Array.isArray(stored)
          ? stored.map((id) => ({ id, kind: 'unknown' }))
          : stored?.items ?? [];
        return { ids: items.map((item) => item.id), items };
      };

      const requestCatalog = async (): Promise<SelectableEntity[]> => {
        const contributions = await context.capabilities.requestAll<SelectionCatalogContribution>(
          'selection.entities@1',
        );
        const byId = new Map<string, SelectableEntity>();
        for (const entity of contributions.flatMap((contribution) => contribution.entities)) {
          if (!byId.has(entity.id)) byId.set(entity.id, entity);
        }
        if (byId.size === 0) {
          const summaries = await context.capabilities.request<ContentSummary[]>('content.summaries@1');
          for (const node of summaries) byId.set(node.id, {
            id: node.id,
            kind: 'text-node',
            bounds: { x: node.x, y: node.y, width: node.width, height: node.height },
          });
        }
        return [...byId.values()];
      };

      const refreshCatalog = async (): Promise<void> => {
        if (catalogRefresh) {
          await catalogRefresh;
          if (appliedCatalogInvalidation < catalogInvalidation) await refreshCatalog();
          return;
        }
        const targetInvalidation = catalogInvalidation;
        catalogRefresh = requestCatalog().then((entities) => {
          catalog.replace(entities);
          catalogReady = true;
          appliedCatalogInvalidation = targetInvalidation;
        }).finally(() => {
          catalogRefresh = undefined;
        });
        await catalogRefresh;
        if (appliedCatalogInvalidation < catalogInvalidation) await refreshCatalog();
      };

      const invalidateCatalog = () => {
        catalogInvalidation += 1;
        void refreshCatalog().catch(() => undefined);
      };

      const ensureCatalogReady = async () => {
        if (!catalogReady) await refreshCatalog();
      };

      const ensureCatalogCurrent = async () => {
        if (!catalogReady || appliedCatalogInvalidation < catalogInvalidation) await refreshCatalog();
      };

      void refreshCatalog().catch(() => undefined);

      const selectionTransaction = (items: SelectionItem[], label: string): TransactionProposal | undefined => {
        const unique = uniqueItems(items);
        if (sameSelection(readSelection().items, unique)) return undefined;
        return ({
          label,
          history: false,
          patches: [
            {
              op: 'set',
              domain: 'workspace',
              namespace: SELECTION_NAMESPACE,
              key: SELECTION_KEY,
              value: { items: unique } satisfies StoredSelection,
            },
          ],
          events: [{ type: 'selection.changed', payload: { ids: unique.map((item) => item.id), items: unique } }],
        });
      };

      const resolveSelection = async (payload: SelectionResolutionRequest): Promise<SelectionResolution> => {
        await ensureCatalogReady();
        const declaredItems = payload.items;
        if (!declaredItems && (payload.ids ?? []).some((id) => !catalog.get(id))) {
          await ensureCatalogCurrent();
        }
        const incoming = payload.items ?? (payload.ids ?? []).map((id) => ({
          id,
          kind: catalog.get(id)?.kind ?? 'unknown',
        }));
        const current = resolveDirectSelection(readSelection().items, catalog);
        const resolvedIncoming = resolveDirectSelection(incoming, catalog, Boolean(declaredItems));
        const preserveCurrent = payload.preserveIfSelected === true &&
          (payload.mode ?? 'replace') === 'replace' &&
          resolvedIncoming.length > 0 &&
          resolvedIncoming.every((item) => current.some((selected) => selected.id === item.id));
        const items = preserveCurrent
          ? current
          : applyMode(current, resolvedIncoming, payload.mode ?? 'replace');
        return {
          ids: items.map((item) => item.id),
          items,
          expandedIds: expandSelectionItems(items, catalog),
        };
      };

      context.commands.register<SelectionSetPayload>({
        type: 'selection.set',
        validate: isSetSelectionPayload,
        handle: async (payload) => {
          const resolution = await resolveSelection(payload);
          return {
            transaction: selectionTransaction(
              resolution.items,
              '更改选择',
            ),
          };
        },
      });

      context.commands.register({
        type: 'selection.clear',
        handle: () => ({ transaction: selectionTransaction([], '清除选择') }),
      });

      context.commands.register<SelectionBoxPayload>({
        type: 'selection.box',
        validate: isSelectionBoxPayload,
        handle: async (payload) => {
          await ensureCatalogCurrent();
          const hits = catalog.query(payload).filter((entity) => boxIntersectsEntity(payload, entity));
          const items = prioritizeBoxHits(hits)
            .map(({ id, kind }) => ({ id, kind }));
          return {
            transaction: selectionTransaction(
              applyMode(
                resolveDirectSelection(readSelection().items, catalog),
                items,
                payload.mode ?? 'replace',
              ),
              '框选画布实体',
            ),
          };
        },
      });

      context.commands.register<SelectionAllPayload | undefined>({
        type: 'selection.all',
        validate: isSelectionAllPayload,
        handle: async (payload = {}) => {
          await ensureCatalogCurrent();
          const entitiesInCatalog = catalog.values();
          let point = payload.point;
          if (!point) {
            try {
              const pointer = await context.capabilities.request<CanvasPointerSnapshot>('canvas.pointer@1');
              if ('point' in pointer) point = pointer.point;
            } catch {
              // A headless or stopped canvas has no pointer scope; Select All remains global.
            }
          }
          if (point) {
            const scopes = (await context.capabilities.requestAll<SelectionScopeContribution | undefined>(
              'selection.scopeAt@1',
              { point } satisfies SelectionScopeAtRequest,
            ))
              .filter(isSelectionScopeContribution)
              .sort((left, right) =>
                (right.priority ?? 0) - (left.priority ?? 0) || left.owner.localeCompare(right.owner));
            const selectableIds = new Set(
              entitiesInCatalog.filter((entity) => entity.includeInSelectAll !== false).map((entity) => entity.id),
            );
            const scoped = scopes[0]
              ? resolveDirectSelection(scopes[0].items, catalog)
                  .filter((item) => selectableIds.has(item.id))
              : [];
            if (scoped.length > 0) {
              return {
                transaction: selectionTransaction(scoped, '全选当前群组内节点'),
              };
            }
          }
          const entities = collapseContainedEntities(
            entitiesInCatalog.filter((entity) => entity.includeInSelectAll !== false),
          );
          return {
            transaction: selectionTransaction(
              entities.map(({ id, kind }) => ({ id, kind })),
              '全选画布实体',
            ),
          };
        },
      });

      context.commands.register({
        type: 'selection.delete',
        handle: async () => {
          const selection = readSelection();
          const resolution = await resolveSelection({ items: selection.items, mode: 'replace' });
          const ids = resolution.expandedIds;
          if (ids.length === 0) return { result: { deleted: 0 } };
          const plans = await context.capabilities.requestAll<EntityDeletePlan>(
            'entity.deletePlan@1',
            { ids, items: resolution.items },
          );
          const patches = plans.flatMap((plan) => plan.patches);
          if (patches.length === 0) return { result: { deleted: 0 } };
          return {
            result: { deleted: ids.length },
            transaction: {
              label: `删除 ${ids.length} 个选中项`,
              patches,
              events: [
                ...plans.flatMap((plan) => plan.events ?? []),
                { type: 'entity.deleted', payload: { ids } },
              ],
            },
          };
        },
      });

      context.events.subscribe('entity.deleted', () => {
        invalidateCatalog();
        void context.commands.dispatch('selection.clear');
      });
      context.events.subscribe('history.changed', () => {
        catalogInvalidation += 1;
        void ensureCatalogCurrent().then(() => {
          const items = readSelection().items
            .filter((item) => catalog.get(item.id))
            .map((item) => {
              const entity = catalog.get(item.id);
              return {
                id: item.id,
                kind: entity?.kind ?? item.kind,
                ...(item.part && entity?.parts?.includes(item.part) ? { part: item.part } : {}),
              };
            });
          void context.commands.dispatch('selection.set', { items, mode: 'replace' });
        }).catch(() => undefined);
      });
      context.events.subscribe('document.replaced', () => {
        catalog.clear();
        catalogReady = false;
        invalidateCatalog();
        void context.commands.dispatch('selection.clear');
      });

      context.signals.subscribe<{ geometry?: boolean }>('content.catalog.invalidated', (message) => {
        if (message.payload.geometry === false) return;
        invalidateCatalog();
      });
      context.signals.subscribe('connections.invalidated', invalidateCatalog);
      context.signals.subscribe('groups.invalidated', invalidateCatalog);
      context.signals.subscribe('annotations.invalidated', invalidateCatalog);

      context.capabilities.provide({
        key: 'selection.read@1',
        invoke: readSelection,
      });
      context.capabilities.provide<SelectionResolutionRequest, SelectionResolution>({
        key: 'selection.resolve@1',
        invoke: (payload) => resolveSelection(payload ?? { items: readSelection().items, mode: 'replace' }),
      });

      context.ui.contribute({
        id: 'selection.actions',
        slot: 'top.contextual',
        kind: 'view',
        label: '选中项操作',
        component: selectionActions,
        priority: 10,
      });
      context.ui.contribute({
        id: 'selection.delete-button',
        slot: 'top.primary',
        kind: 'button',
        label: '删除选中项',
        icon: 'trash',
        group: 'clipboard',
        tooltip: '删除选中项（Delete）',
        command: 'selection.delete',
        priority: 40,
      });

      context.ui.shortcut({
        id: 'selection.all-shortcut',
        chord: 'mod+a',
        command: 'selection.all',
        label: '全选节点',
      });
      context.ui.shortcut({
        id: 'selection.delete-shortcut',
        chord: 'delete',
        command: 'selection.delete',
        label: '删除选中项',
      });
      context.ui.action({
        id: 'selection.all-action',
        label: '全选画布节点',
        command: 'selection.all',
        category: '选择',
        keywords: ['全选', '节点', 'select all'],
        priority: 60,
      });
      context.ui.action({
        id: 'selection.delete-action',
        label: '删除选中项',
        command: 'selection.delete',
        category: '选择',
        keywords: ['删除', '移除', 'delete'],
        priority: 61,
      });
      context.ui.shortcut({
        id: 'selection.clear-shortcut',
        chord: 'escape',
        command: 'selection.clear',
        label: '取消选择',
      });
      context.ui.action({
        id: 'selection.clear-action',
        label: '取消选择',
        command: 'selection.clear',
        category: '选择',
        keywords: ['清除', '取消选择', 'escape'],
        priority: 62,
      });
      context.ui.shortcut({
        id: 'selection.backspace-shortcut',
        chord: 'backspace',
        command: 'selection.delete',
        label: '删除选中项',
      });
    },
  };
}

function applyMode(current: SelectionItem[], incoming: SelectionItem[], mode: SelectionMode): SelectionItem[] {
  if (mode === 'replace') return uniqueItems(incoming);
  const next = new Map(current.map((item) => [item.id, item]));
  for (const item of incoming) {
    if (mode === 'add') next.set(item.id, item);
    if (mode === 'remove') next.delete(item.id);
    if (mode === 'toggle') {
      if (next.has(item.id)) next.delete(item.id);
      else next.set(item.id, item);
    }
  }
  return [...next.values()];
}

function uniqueItems(items: SelectionItem[]): SelectionItem[] {
  return [...new Map(items.map((item) => [item.id, {
    id: item.id,
    kind: item.kind,
    ...(item.part ? { part: item.part } : {}),
  }])).values()];
}

function prioritizeBoxHits(entities: SelectableEntity[]): SelectableEntity[] {
  const containsNodeOrGroup = entities.some(
    (entity) => entity.kind === 'text-node' || entity.kind === 'group',
  );
  const withoutConnections = containsNodeOrGroup
    ? entities.filter((entity) => entity.kind !== 'connection')
    : entities;
  return collapseContainedEntities(withoutConnections);
}

function collapseContainedEntities(entities: SelectableEntity[]): SelectableEntity[] {
  const selectedIds = new Set(entities.map((entity) => entity.id));
  const contained = new Set(
    entities.flatMap((entity) => entity.contains ?? []).filter((id) => selectedIds.has(id)),
  );
  return entities.filter((entity) => !contained.has(entity.id));
}

function resolveDirectSelection(
  items: SelectionItem[],
  catalog: Pick<SelectionCatalogIndex, 'get'>,
  allowDeclaredMissing = false,
): SelectionItem[] {
  return uniqueItems(items
    .flatMap((item) => {
      const entity = catalog.get(item.id);
      if (!entity) {
        return allowDeclaredMissing && item.kind !== 'unknown'
          ? [{ id: item.id, kind: item.kind, ...(item.part ? { part: item.part } : {}) }]
          : [];
      }
      const part = item.part && entity.parts?.includes(item.part) ? item.part : undefined;
      return [{ id: item.id, kind: entity.kind, ...(part ? { part } : {}) }];
    }));
}

function expandSelectionItems(
  items: SelectionItem[],
  catalog: Pick<SelectionCatalogIndex, 'get'>,
): string[] {
  const expanded = new Set<string>();
  const visit = (id: string) => {
    if (expanded.has(id)) return;
    expanded.add(id);
    for (const containedId of catalog.get(id)?.contains ?? []) visit(containedId);
  };
  for (const item of items) visit(item.id);
  return [...expanded];
}

function sameSelection(left: SelectionItem[], right: SelectionItem[]): boolean {
  return left.length === right.length && left.every((item, index) =>
    item.id === right[index]?.id && item.kind === right[index]?.kind && item.part === right[index]?.part);
}

function intersects(
  a: { x: number; y: number; width: number; height: number },
  b: { x: number; y: number; width: number; height: number },
): boolean {
  return a.x <= b.x + b.width && a.x + a.width >= b.x && a.y <= b.y + b.height && a.y + a.height >= b.y;
}

function boxIntersectsEntity(
  box: { x: number; y: number; width: number; height: number },
  entity: SelectableEntity,
): boolean {
  const matches = (bounds: { x: number; y: number; width: number; height: number }) =>
    entity.boxMatch === 'contain' ? containsBounds(box, bounds) : intersects(box, bounds);
  if (entity.boxRegions?.length) return entity.boxRegions.some(matches);
  return Boolean(entity.bounds && matches(entity.bounds));
}

function containsBounds(
  outer: { x: number; y: number; width: number; height: number },
  inner: { x: number; y: number; width: number; height: number },
): boolean {
  return outer.x <= inner.x && outer.y <= inner.y &&
    outer.x + outer.width >= inner.x + inner.width &&
    outer.y + outer.height >= inner.y + inner.height;
}

function isSetSelectionPayload(payload: unknown): payload is SelectionSetPayload {
  if (!isRecord(payload)) return false;
  const hasIds = Array.isArray(payload.ids) && payload.ids.every((id) => typeof id === 'string');
  const hasItems = Array.isArray(payload.items) && payload.items.every((item) =>
    isRecord(item) && typeof item.id === 'string' && typeof item.kind === 'string' &&
    (item.part === undefined || typeof item.part === 'string'));
  return (hasIds || hasItems) &&
    (payload.mode === undefined || ['replace', 'add', 'remove', 'toggle'].includes(String(payload.mode)));
}

function isSelectionBoxPayload(payload: unknown): payload is SelectionBoxPayload {
  return (
    isRecord(payload) &&
    Number.isFinite(payload.x) &&
    Number.isFinite(payload.y) &&
    Number.isFinite(payload.width) &&
    Number.isFinite(payload.height) &&
    (payload.mode === undefined || ['replace', 'add', 'remove', 'toggle'].includes(String(payload.mode)))
  );
}

function isSelectionAllPayload(payload: unknown): payload is SelectionAllPayload | undefined {
  return payload === undefined || (isRecord(payload) && (payload.point === undefined || (
    isRecord(payload.point) && Number.isFinite(payload.point.x) && Number.isFinite(payload.point.y)
  )));
}

function isSelectionScopeContribution(value: unknown): value is SelectionScopeContribution {
  return isRecord(value) && typeof value.owner === 'string' && value.owner.length > 0 &&
    (value.priority === undefined || (typeof value.priority === 'number' && Number.isFinite(value.priority))) &&
    Array.isArray(value.items) && value.items.length > 0 && value.items.every((item) =>
      isRecord(item) && typeof item.id === 'string' && typeof item.kind === 'string');
}
