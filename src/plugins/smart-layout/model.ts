import type { PluginDefinition } from '../../core/contracts.ts';
import { SpatialHashIndex } from '../../services/spatial-index.ts';
import type {
  ArrangeMode,
  GridArrangePlan,
  GridArrangePlanRequest,
  SmartSnapRequest,
  SmartSnapResult,
  SmartResizeSnapRequest,
  SmartResizeSnapResult,
} from '../../protocols/layout.ts';
import type {
  SelectableEntity,
  SelectionCatalogContribution,
  SelectionSnapshot,
} from '../../protocols/selection.ts';
import type { WorldBounds } from '../../protocols/viewport.ts';
import { defineManifest } from '../manifest.ts';
import { snapDraggedBounds, snapResizedBounds } from './alignment.ts';

interface SnapEntity extends WorldBounds {
  id: string;
  kind: 'text-node' | 'group';
  contains?: string[];
}

const SNAP_SEARCH_MARGIN = 960;
const DISTANT_AXIS_REFERENCE_LIMIT = 36;
const ARRANGE_CYCLE_RESET_MS = 1_600;

export function createSmartLayoutPlugin(arrangeGridActions?: unknown): PluginDefinition {
  return {
    manifest: defineManifest('smart-layout', '智能参考线与自动排列', {
      requiresCapabilities: ['selection.read@1', 'selection.entities@1', 'layout.gridPlan@1'],
      providesCapabilities: ['layout.snap@1', 'layout.resizeSnap@1'],
      commands: [
        'node.arrangeSelectedCycle',
        'node.arrangeSelectedGrid',
        'node.arrangeSelectedGrid.horizontal',
        'node.arrangeSelectedGrid.vertical',
      ],
      events: ['plugin.lifecycle.changed'],
      signals: ['content.catalog.invalidated', 'groups.invalidated'],
      ui: ['smart-layout.arrange-grid'],
      actions: [
        'smart-layout.arrange-grid-action',
      ],
      shortcuts: [
        'smart-layout.arrange-grid-shortcut',
      ],
      permissions: ['ui.top.contribute', 'ui.action.register', 'ui.shortcut.register'],
    }),

    async start(context) {
      const allEntities = new SpatialHashIndex<SnapEntity>();
      const topLevelEntities = new SpatialHashIndex<SnapEntity>();
      let allEntityList: SnapEntity[] = [];
      let topLevelEntityList: SnapEntity[] = [];
      let refreshVersion = 0;

      const refreshReferences = async () => {
        const version = ++refreshVersion;
        const catalogs = await context.capabilities.requestAll<SelectionCatalogContribution>(
          'selection.entities@1',
        );
        if (version !== refreshVersion) return;
        const entities = catalogs
          .flatMap((catalog) => catalog.entities)
          .flatMap(toSnapEntity);
        const contained = new Set(
          entities.filter((entity) => entity.kind === 'group').flatMap((entity) => entity.contains ?? []),
        );
        const topLevel = entities.filter((entity) =>
          entity.kind === 'group' || !contained.has(entity.id));
        allEntityList = entities;
        topLevelEntityList = topLevel;
        allEntities.rebuild(entities, (entity) => entity.id, (entity) => entity);
        topLevelEntities.rebuild(topLevel, (entity) => entity.id, (entity) => entity);
      };
      const scheduleRefresh = () => {
        void refreshReferences().catch((error) => {
          context.diagnostics.warn('智能布局参考对象刷新失败', error);
        });
      };

      context.signals.subscribe('content.catalog.invalidated', scheduleRefresh);
      context.signals.subscribe('groups.invalidated', scheduleRefresh);
      context.events.subscribe('plugin.lifecycle.changed', scheduleRefresh);
      await refreshReferences();

      context.capabilities.provide<SmartSnapRequest, SmartSnapResult>({
        key: 'layout.snap@1',
        invoke: (input) => {
          if (!isSmartSnapRequest(input)) throw new Error('智能吸附请求不正确');
          const moving = new Set(input.movingIds);
          const margin = Math.max(SNAP_SEARCH_MARGIN, input.threshold * 8);
          const index = input.mode === 'group' ? topLevelEntities : allEntities;
          const entityList = input.mode === 'group' ? topLevelEntityList : allEntityList;
          const nearby = index.query({
            x: input.dragged.x - margin,
            y: input.dragged.y - margin,
            width: input.dragged.width + margin * 2,
            height: input.dragged.height + margin * 2,
          });
          // Equal-spacing guides often need one distant sibling that sits well
          // beyond the ordinary pointer-neighbourhood. Keep the hot path bounded:
          // merge only the nearest entities on each axis, never scan pairs across
          // the entire document inside the alignment engine.
          const references = mergeSnapReferences(
            nearby,
            nearestOnAxes(input.dragged, entityList, DISTANT_AXIS_REFERENCE_LIMIT),
          ).filter((entity) =>
            !moving.has(entity.id) && !(entity.contains ?? []).some((id) => moving.has(id)));
          return snapDraggedBounds(input.dragged, references, input.threshold);
        },
      });

      context.capabilities.provide<SmartResizeSnapRequest, SmartResizeSnapResult>({
        key: 'layout.resizeSnap@1',
        invoke: (input) => {
          if (!isSmartResizeSnapRequest(input)) throw new Error('缩放智能吸附请求不正确');
          const margin = Math.max(SNAP_SEARCH_MARGIN, input.threshold * 8);
          const nearby = allEntities.query({
            x: input.resized.x - margin,
            y: input.resized.y - margin,
            width: input.resized.width + margin * 2,
            height: input.resized.height + margin * 2,
          }).filter((entity) =>
            entity.id !== input.resizingId && !(entity.contains ?? []).includes(input.resizingId));
          return snapResizedBounds(input.resized, nearby, input.threshold);
        },
      });

      const buildArrangement = async (mode: ArrangeMode) => {
        const selection = await context.capabilities.request<SelectionSnapshot>('selection.read@1');
        const plan = await context.capabilities.request<GridArrangePlan>(
          'layout.gridPlan@1',
          { nodeIds: selection.ids, mode } satisfies GridArrangePlanRequest,
        );
        const modeLabel = mode === 'grid' ? '宫格' : mode === 'horizontal' ? '横排' : '竖排';
        return {
          plan,
          outcome: {
            result: {
              selected: plan.selected,
              changed: plan.changed,
              columns: plan.columns,
              mode,
            },
            transaction: plan.patches.length > 0 ? {
              label: `${modeLabel}排列 ${plan.selected} 个文本节点`,
              patches: plan.patches,
              events: plan.events,
            } : undefined,
          },
        };
      };
      const arrange = (type: string, mode: ArrangeMode) => context.commands.register({
        type,
        handle: async () => {
          const { outcome } = await buildArrangement(mode);
          const result = outcome.result as {
            selected: number;
            changed: number;
            columns: number;
          };
          return {
            ...outcome,
            result: {
              selected: result.selected,
              changed: result.changed,
              columns: result.columns,
            },
          };
        },
      });
      let nextCycleMode: ArrangeMode = 'grid';
      let lastCycleAt = 0;
      context.commands.register({
        type: 'node.arrangeSelectedCycle',
        handle: async () => {
          const now = Date.now();
          if (now - lastCycleAt > ARRANGE_CYCLE_RESET_MS) nextCycleMode = 'grid';
          const mode = nextCycleMode;
          nextCycleMode = mode === 'grid' ? 'horizontal' : mode === 'horizontal' ? 'vertical' : 'grid';
          lastCycleAt = now;
          const { outcome } = await buildArrangement(mode);
          return {
            ...outcome,
            result: {
              ...(outcome.result as Record<string, unknown>),
              nextMode: nextCycleMode,
              resetAfterMs: ARRANGE_CYCLE_RESET_MS,
            },
          };
        },
      });
      arrange('node.arrangeSelectedGrid', 'grid');
      arrange('node.arrangeSelectedGrid.horizontal', 'horizontal');
      arrange('node.arrangeSelectedGrid.vertical', 'vertical');

      context.ui.contribute({
        id: 'smart-layout.arrange-grid',
        slot: 'top.primary',
        kind: 'view',
        label: '自动排列',
        group: 'appearance',
        component: arrangeGridActions,
        priority: 20,
      });
      context.ui.shortcut({
        id: 'smart-layout.arrange-grid-shortcut',
        chord: 'mod+shift+l',
        command: 'node.arrangeSelectedCycle',
        label: '自动排列选中文字节点（宫格、横排、竖排）',
        category: '画布',
      });
      context.ui.action({
        id: 'smart-layout.arrange-grid-action',
        label: '自动排列选中文字节点（宫格、横排、竖排）',
        command: 'node.arrangeSelectedCycle',
        category: '画布',
        keywords: ['排列', '宫格', '网格', '横排', '竖排', '对齐', '恢复大小', 'arrange', 'grid'],
        priority: 67,
      });
    },
  };
}

function toSnapEntity(entity: SelectableEntity): SnapEntity[] {
  if (!entity.bounds || (entity.kind !== 'text-node' && entity.kind !== 'group')) return [];
  const values = [entity.bounds.x, entity.bounds.y, entity.bounds.width, entity.bounds.height];
  if (!values.every(Number.isFinite)) return [];
  return [{
    id: entity.id,
    kind: entity.kind,
    ...entity.bounds,
    ...(entity.contains ? { contains: [...entity.contains] } : {}),
  }];
}

function nearestOnAxes(
  dragged: WorldBounds,
  entities: SnapEntity[],
  limit: number,
): SnapEntity[] {
  const centerX = dragged.x + dragged.width / 2;
  const centerY = dragged.y + dragged.height / 2;
  const horizontal = entities
    .filter((entity) => rangesOverlap(
      dragged.y,
      dragged.y + dragged.height,
      entity.y,
      entity.y + entity.height,
    ))
    .sort((left, right) =>
      Math.abs(left.x + left.width / 2 - centerX) -
      Math.abs(right.x + right.width / 2 - centerX) || left.id.localeCompare(right.id))
    .slice(0, limit);
  const vertical = entities
    .filter((entity) => rangesOverlap(
      dragged.x,
      dragged.x + dragged.width,
      entity.x,
      entity.x + entity.width,
    ))
    .sort((left, right) =>
      Math.abs(left.y + left.height / 2 - centerY) -
      Math.abs(right.y + right.height / 2 - centerY) || left.id.localeCompare(right.id))
    .slice(0, limit);
  return mergeSnapReferences(horizontal, vertical);
}

function mergeSnapReferences(...collections: SnapEntity[][]): SnapEntity[] {
  const merged = new Map<string, SnapEntity>();
  for (const collection of collections) {
    for (const entity of collection) merged.set(entity.id, entity);
  }
  return [...merged.values()];
}

function rangesOverlap(firstStart: number, firstEnd: number, secondStart: number, secondEnd: number): boolean {
  return firstStart <= secondEnd && firstEnd >= secondStart;
}

function isSmartSnapRequest(value: unknown): value is SmartSnapRequest {
  if (!value || typeof value !== 'object') return false;
  const input = value as Partial<SmartSnapRequest>;
  const bounds = input.dragged;
  return Boolean(
    bounds && [bounds.x, bounds.y, bounds.width, bounds.height].every(Number.isFinite) &&
    Array.isArray(input.movingIds) && input.movingIds.every((id) => typeof id === 'string') &&
    (input.mode === 'nodes' || input.mode === 'group') &&
    Number.isFinite(input.threshold) && (input.threshold ?? 0) > 0,
  );
}

function isSmartResizeSnapRequest(value: unknown): value is SmartResizeSnapRequest {
  if (!value || typeof value !== 'object') return false;
  const input = value as Partial<SmartResizeSnapRequest>;
  const bounds = input.resized;
  return Boolean(
    bounds && [bounds.x, bounds.y, bounds.width, bounds.height].every(Number.isFinite) &&
    typeof input.resizingId === 'string' && input.resizingId.length > 0 &&
    Number.isFinite(input.threshold) && (input.threshold ?? 0) > 0,
  );
}
