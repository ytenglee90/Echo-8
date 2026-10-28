import {
  createId,
  isRecord,
  type PatchOperation,
  type PluginDefinition,
} from '../../core/contracts.ts';
import type {
  ContentClonePlanRequest,
  ContentMaterializeCopyRequest,
  ContentMutationPlan,
  ContentRenamePlan,
  ContentSummary,
  SetNodePresentationRequest,
  SetNodePresentationResult,
} from '../../protocols/content.ts';
import type {
  ContentAnnotationCloneRequest,
  ContentAnchorMoveRequest,
  ContentAnchorTransformPlan,
  ContentAnchorTransformRequest,
} from '../../protocols/annotations.ts';
import type { CanvasViewportCenter } from '../../protocols/canvas.ts';
import {
  DEFAULT_TEXT_DOCUMENT_FORMAT,
  type TextFormatMark,
} from '../../protocols/formatting.ts';
import type { SelectionSnapshot } from '../../protocols/selection.ts';
import type { GridArrangePlan, GridArrangePlanRequest } from '../../protocols/layout.ts';
import { defineManifest } from '../manifest.ts';
import { ONBOARDING_NODE_SEEDS } from './onboarding.ts';
import {
  arrangeNodesInGrid,
} from './grid-layout.ts';
import {
  createNodeTitleAllocator,
  isNodeTitleTaken,
  normalizeNodeTitle,
} from './title-policy.ts';
import {
  CONTENT_CHUNK_NAMESPACE,
  MAX_DOCUMENT_LENGTH,
  createContentStorage,
  isVersionTwoContent,
  planContentDelta,
  planContentMove,
  planContentReplacements,
  readContentChunk,
  readContentRange,
  type TextContentRecord,
} from './content-storage.ts';
import {
  FORMAT_MARK_NAMESPACE,
  FORMAT_NAMESPACE,
  MAX_FORMAT_MARKS_PER_NODE,
  isSetDocumentFormatRequest,
  isSetRangeFormatRequest,
  planFormattingEdits,
  planFormattingMove,
  readFormatMarks,
  readFormatRecord,
  toFormatSnapshot,
  toFormattingSnapshot,
  validateDocumentFormat,
  validateFormatPatch,
  type TextFormatRecord,
} from './formatting-storage.ts';
import {
  CONTENT_NAMESPACE,
  DEFAULT_NODE_HEIGHT,
  DEFAULT_NODE_WIDTH,
  NODE_NAMESPACE,
  buildMovePlan,
  clampNodeSize,
  defaultNodeSize,
  isCanvasTextNode,
  isDeltaPayload,
  isMoveManyPayload,
  isMovePayload,
  isMoveRangePayload,
  isResizePayload,
  nodeHeight,
  nodePresentation,
  nodePreviewLength,
  nodeResizeLimits,
  rememberedNodeSize,
  withRememberedNodeSize,
  defaultNodeTitleColor,
  type CreateNodePayload,
  type MoveManyPayload,
  type MoveNodePayload,
  type RenameNodePayload,
  type ResetNodeSizePayload,
  type ResizeNodePayload,
  type TextNodeRecord,
} from './operations.ts';
import { registerTextNodeCapabilities } from './capability-runtime.ts';
import {
  findLinkedTitleHits,
  isReferenceTitle,
  MAX_TITLE_REFERENCE_REPLACEMENTS,
} from './title-reference-sync.ts';
export function createTextNodePlugin(canvasLayer?: unknown, emptyState?: unknown): PluginDefinition {
  return {
  manifest: defineManifest('text-node', '文本节点', {
    dataVersion: 2,
    namespaces: [
      NODE_NAMESPACE,
      CONTENT_NAMESPACE,
      CONTENT_CHUNK_NAMESPACE,
      FORMAT_NAMESPACE,
      FORMAT_MARK_NAMESPACE,
    ],
    namespaceDomains: {
      [NODE_NAMESPACE]: 'document',
      [CONTENT_NAMESPACE]: 'document',
      [CONTENT_CHUNK_NAMESPACE]: 'document',
      [FORMAT_NAMESPACE]: 'document',
      [FORMAT_MARK_NAMESPACE]: 'document',
    },
    optionalCapabilities: [
      'canvas.viewportCenter@1',
      'selection.read@1',
      'content.anchorTransformPlan@1',
      'content.anchorMovePlan@1',
      'content.annotationClonePlan@1',
    ],
    commands: [
      'node.create',
      'content.materializeCopy',
      'node.seed',
      'node.move',
      'node.moveMany',
      'node.resize',
      'node.resetSize',
      'node.resetSelectedSizes',
      'node.toggleSelectedPresentation',
      'node.rename',
      'node.presentation.set',
      'content.applyDelta',
      'content.moveRange',
      'content.migrateStorage',
      'content.setDocumentFormat',
      'content.setRangeFormat',
    ],
    dispatches: ['editor.open', 'connection.create'],
    queries: ['textNode.count'],
    providesCapabilities: [
      'content.summaries@1',
      'content.catalog@2',
      'content.metrics@1',
      'content.metrics@2',
      'content.metrics@3',
      'content.summariesById@1',
      'content.read@1',
      'content.storageInfo@1',
      'content.movePlan@1',
      'content.renamePlan@1',
      'entity.deletePlan@1',
      'clipboard.serialize@1',
      'clipboard.instantiate@1',
      'content.search@1',
      'content.replacePlan@1',
      'content.statistics@1',
      'content.formatting@1',
      'content.formatting@2',
      'appearance.read@1',
      'appearance.updatePlan@1',
      'appearance.colors@1',
      'appearance.resetPlan@1',
      'content.createPlan@1',
      'content.placementPlan@1',
      'content.clonePlan@1',
      'content.appendPlan@1',
      'content.deltaPlan@1',
      'selection.entities@1',
      'layout.gridPlan@1',
      'context.catalog@1',
      'context.read@1',
      'context.search@1',
    ],
    permissions: [
      'store.own.read',
      'store.own.write',
      'ui.top.contribute',
      'ui.canvas.contribute',
      'ui.action.register',
      'ui.shortcut.register',
    ],
    events: [
      'node.created',
      'node.moved',
      'nodes.moved',
      'node.resized',
      'node.renamed',
      'node.presentation.changed',
      'node.appearance.changed',
      'node.placement.changed',
      'content.changed',
      'content.format.changed',
      'nodes.deleted',
      'nodes.pasted',
      'history.changed',
      'document.replaced',
    ],
    signals: ['content.catalog.invalidated'],
    ui: [
      'text-node.canvas-layer',
      'text-node.empty-state',
      'text-node.create',
      'text-node.toggle-selected-presentation',
    ],
    actions: ['text-node.create-action', 'text-node.toggle-selected-presentation-action'],
    shortcuts: [
      'text-node.create-shortcut',
      'text-node.reset-selected-sizes-shortcut',
      'text-node.toggle-selected-presentation-shortcut',
    ],
  }),

  migrations: [{
    from: 1,
    to: 2,
    migrate: (data) => ({
      ...data,
      [NODE_NAMESPACE]: Object.fromEntries(
        Object.entries(data[NODE_NAMESPACE] ?? {}).map(([id, value]) => {
          if (!isRecord(value)) return [id, value];
          const width = clampNodeSize(
            Number.isFinite(value.width) ? Number(value.width) : DEFAULT_NODE_WIDTH,
            nodeResizeLimits('card').minWidth,
            nodeResizeLimits('card').maxWidth,
          );
          const height = clampNodeSize(
            Number.isFinite(value.height) ? Number(value.height) : DEFAULT_NODE_HEIGHT,
            nodeResizeLimits('card').minHeight,
            nodeResizeLimits('card').maxHeight,
          );
          return [id, {
            ...value,
            presentation: 'card',
            width,
            height,
            cardSize: { width, height },
          }];
        }),
      ),
    }),
  }],

  async start(context) {
    const readNodes = () =>
      context.store.readNamespace<Record<string, TextNodeRecord>>(NODE_NAMESPACE);
    let nodeIndexCache: {
      revision: number;
      nodesById: Map<string, TextNodeRecord>;
      nodes: TextNodeRecord[];
      canvasCount: number;
    } | undefined;
    const readNodeIndex = () => {
      const revision = context.store.revision(NODE_NAMESPACE);
      if (nodeIndexCache?.revision === revision) return nodeIndexCache;
      if (nodeIndexCache) {
        const changes = context.store.changes(NODE_NAMESPACE, nodeIndexCache.revision);
        if (!changes.reset) {
          for (const id of changes.keys) {
            const node = context.store.readValue<TextNodeRecord>(NODE_NAMESPACE, id);
            if (node) nodeIndexCache.nodesById.set(id, node);
            else nodeIndexCache.nodesById.delete(id);
          }
          const nodes = [...nodeIndexCache.nodesById.values()];
          nodeIndexCache = {
            revision: changes.revision,
            nodesById: nodeIndexCache.nodesById,
            nodes,
            canvasCount: nodes.filter(isCanvasTextNode).length,
          };
          return nodeIndexCache;
        }
      }
      const nodesById = new Map(Object.entries(readNodes()));
      const nodes = [...nodesById.values()];
      nodeIndexCache = {
        revision,
        nodesById,
        nodes,
        canvasCount: nodes.filter(isCanvasTextNode).length,
      };
      return nodeIndexCache;
    };
    const reservationAllocators = new WeakMap<string[], {
      revision: number;
      length: number;
      allocator: ReturnType<typeof createNodeTitleAllocator>;
    }>();
    const titleAllocator = (reservedTitles: Iterable<string>) => {
      const index = readNodeIndex();
      if (!Array.isArray(reservedTitles)) {
        const allocator = createNodeTitleAllocator(index.nodes.map((node) => node.title));
        for (const title of reservedTitles) allocator.reserve(title);
        return allocator;
      }
      let cached = reservationAllocators.get(reservedTitles);
      if (!cached || cached.revision !== index.revision || cached.length > reservedTitles.length) {
        cached = {
          revision: index.revision,
          length: 0,
          allocator: createNodeTitleAllocator(index.nodes.map((node) => node.title)),
        };
        reservationAllocators.set(reservedTitles, cached);
      }
      for (let position = cached.length; position < reservedTitles.length; position += 1) {
        cached.allocator.reserve(reservedTitles[position]);
      }
      cached.length = reservedTitles.length;
      return cached.allocator;
    };
    const planExternalAnchors = (input: ContentAnchorTransformRequest) =>
      context.capabilities.requestAll<ContentAnchorTransformPlan>('content.anchorTransformPlan@1', input);
    const planExternalAnchorMove = (input: ContentAnchorMoveRequest) =>
      context.capabilities.requestAll<ContentAnchorTransformPlan>('content.anchorMovePlan@1', input);
    const planExternalAnnotationClones = (input: ContentAnnotationCloneRequest) =>
      context.capabilities.requestAll<ContentAnchorTransformPlan>('content.annotationClonePlan@1', input);
    const readContents = () =>
      context.store.readNamespace<Record<string, TextContentRecord>>(CONTENT_NAMESPACE);
    const statisticsCache = new Map<string, {
      signature: string;
      graphemes: number;
      nonWhitespaceGraphemes: number;
      writingUnits: number;
      words: number;
      lines: number;
    }>();
    let catalogVersion = 0;
    const catalogChanges: Array<{ version: number; ids?: string[]; reset?: true }> = [];
    const summarizeNode = (
      node: TextNodeRecord,
      contents: Record<string, TextContentRecord>,
    ): ContentSummary => {
      const content = contents[node.contentId];
      const preview = content && nodePresentation(node) === 'card'
        ? readContentRange(context, content, 0, nodePreviewLength(node))
        : '';
      return {
        id: node.id,
        title: node.title,
        preview,
        x: node.x,
        y: node.y,
        width: node.width,
        height: nodeHeight(node),
        titleColor: node.titleColor,
        textColor: readFormatRecord(context, node.id).format.color,
        presentation: nodePresentation(node),
        resizeLimits: nodeResizeLimits(nodePresentation(node)),
        revision: content?.revision ?? 0,
        nodeRevision: node.revision,
        length: content?.length ?? 0,
      };
    };
    const readSummaries = (ids?: Iterable<string>, includeSystem = false): ContentSummary[] => {
      const nodes = readNodes();
      const contents = readContents();
      const selected = (ids ? [...new Set(ids)].map((id) => nodes[id]).filter(Boolean) : Object.values(nodes))
        .filter((node) => includeSystem || isCanvasTextNode(node));
      return selected.map((node) => summarizeNode(node, contents));
    };
    const invalidateCatalog = (ids?: string[], reset = false, geometry = false) => {
      const normalized = reset ? undefined : [...new Set((ids ?? []).filter(Boolean))];
      if (!reset && normalized?.length === 0) return;
      catalogVersion += 1;
      catalogChanges.push(reset
        ? { version: catalogVersion, reset: true }
        : { version: catalogVersion, ids: normalized });
      if (catalogChanges.length > 512) catalogChanges.splice(0, catalogChanges.length - 512);
      context.signals.emit('content.catalog.invalidated', { version: catalogVersion, geometry: reset || geometry });
    };

    const buildCreateTransaction = (payload: CreateNodePayload, reservedTitles: Iterable<string> = []) => {
      const reservations = Array.isArray(reservedTitles) ? reservedTitles : [...reservedTitles];
      const nodeIndex = readNodeIndex();
      const count = nodeIndex.canvasCount + reservations.length;
      const nodeId = createId('node');
      const contentId = createId('content');
      const now = Date.now();
      const body = payload.body ?? '';
      const resolvedTitle = titleAllocator(reservations).allocate(payload.title);
      const width = clampNodeSize(
        payload.width ?? DEFAULT_NODE_WIDTH,
        nodeResizeLimits('card').minWidth,
        nodeResizeLimits('card').maxWidth,
      );
      const height = clampNodeSize(
        payload.height ?? DEFAULT_NODE_HEIGHT,
        nodeResizeLimits('card').minHeight,
        nodeResizeLimits('card').maxHeight,
      );
      const node: TextNodeRecord = {
        id: nodeId,
        contentId,
        title: resolvedTitle,
        x: payload.x ?? 160 + (count % 5) * 320,
        y: payload.y ?? 130 + Math.floor(count / 5) * 240,
        width,
        height,
        presentation: 'card',
        cardSize: { width, height },
        titleColor: defaultNodeTitleColor(count),
        ...(payload.automaticContext === false ? { automaticContext: false } : {}),
        ...(payload.placement === 'system' ? { placement: 'system' as const } : {}),
        revision: 1,
        createdAt: now,
        updatedAt: now,
      };
      if (body.length > MAX_DOCUMENT_LENGTH) throw new Error('单个正文当前最多支持 3200 万 UTF-16 字符');
      const createdContent = createContentStorage(contentId, body, 1);
      const content = createdContent.content;
      const format: TextFormatRecord = {
        nodeId,
        storageVersion: 2,
        markIds: [],
        revision: 1,
        format: { ...DEFAULT_TEXT_DOCUMENT_FORMAT },
      };
      return {
        nodeId,
        resolvedTitle,
        transaction: {
          label: '创建文本节点',
          history: payload.history !== false,
          patches: [
            { op: 'set' as const, domain: 'document' as const, namespace: NODE_NAMESPACE, key: nodeId, value: node },
            {
              op: 'set' as const,
              domain: 'document' as const,
              namespace: CONTENT_NAMESPACE,
              key: contentId,
              value: content,
            },
            ...createdContent.chunkPatches,
            {
              op: 'set' as const,
              domain: 'document' as const,
              namespace: FORMAT_NAMESPACE,
              key: nodeId,
              value: format,
            },
          ],
          events: [{ type: 'node.created', payload: { id: nodeId } }],
        },
      };
    };

    const planNodeRename = async (
      node: TextNodeRecord,
      title: string,
    ): Promise<ContentRenamePlan> => {
      if (title === node.title) {
        return {
          nodeId: node.id,
          nodeRevision: node.revision,
          resolvedTitle: title,
          patches: [],
        };
      }
      const now = Date.now();
      const next: TextNodeRecord = {
        ...node,
        title,
        revision: node.revision + 1,
        updatedAt: now,
      };
      const patches: PatchOperation[] = [{
        op: 'set',
        domain: 'document',
        namespace: NODE_NAMESPACE,
        key: node.id,
        value: next,
        schemaOwner: 'text-node',
      }];
      const events: NonNullable<ContentRenamePlan['events']> = [
        { type: 'node.renamed', payload: { id: node.id } },
      ];
      if (isReferenceTitle(node.title)) {
        const canvasNodes = readNodeIndex().nodes.filter(isCanvasTextNode);
        const catalogTitles = canvasNodes
          .map((candidate) => candidate.title.trim())
          .filter(isReferenceTitle);
        let replacementCount = 0;
        for (const referencingNode of canvasNodes) {
          if (referencingNode.id === node.id) continue;
          const content = context.store.readValue<TextContentRecord>(CONTENT_NAMESPACE, referencingNode.contentId);
          if (!content) continue;
          const remaining = MAX_TITLE_REFERENCE_REPLACEMENTS - replacementCount;
          const found = await findLinkedTitleHits({
            node: referencingNode,
            content,
            targetNodeId: node.id,
            targetTitle: node.title,
            catalogTitles,
            readChunk: (index) => readContentChunk(context, content, index),
            limit: remaining + 1,
          });
          if (found.hits.length > remaining) {
            throw new Error(`标题“${node.title}”在正文中的关联超过 ${MAX_TITLE_REFERENCE_REPLACEMENTS} 处，请先减少关联再重命名`);
          }
          if (found.hits.length === 0) continue;
          replacementCount += found.hits.length;
          const mutation = planContentReplacements(context, content, found.hits, title);
          const formatMutation = planFormattingEdits(
            context,
            referencingNode.id,
            [...found.hits]
              .sort((left, right) => right.start - left.start)
              .map((hit) => ({
                start: hit.start,
                deleteCount: hit.length,
                insertLength: title.length,
              })),
          );
          patches.push(
            ...mutation.chunkPatches.map((patch) => ({ ...patch, schemaOwner: 'text-node' as const })),
            {
              op: 'set',
              domain: 'document',
              namespace: CONTENT_NAMESPACE,
              key: content.id,
              value: mutation.content,
              schemaOwner: 'text-node',
            },
            {
              op: 'set',
              domain: 'document',
              namespace: NODE_NAMESPACE,
              key: referencingNode.id,
              value: { ...referencingNode, revision: referencingNode.revision + 1, updatedAt: now },
              schemaOwner: 'text-node',
            },
            ...formatMutation.patches.map((patch) => ({ ...patch, schemaOwner: 'text-node' as const })),
          );
          events.push({
            type: 'content.changed',
            payload: {
              nodeId: referencingNode.id,
              revision: mutation.content.revision,
              length: mutation.content.length,
            },
          });
          if (formatMutation.revision !== undefined) events.push({
            type: 'content.format.changed',
            payload: { nodeId: referencingNode.id, revision: formatMutation.revision },
          });
        }
      }
      return {
        nodeId: node.id,
        nodeRevision: next.revision,
        resolvedTitle: title,
        patches,
        events,
      };
    };

    context.commands.register<CreateNodePayload, { id: string }>({
      type: 'node.create',
      validate: (payload): payload is CreateNodePayload => payload === undefined || isRecord(payload),
      handle: async (payload = {}) => {
        let positionedPayload = payload;
        if (payload.x === undefined || payload.y === undefined) {
          try {
            const center = await context.capabilities.request<CanvasViewportCenter>('canvas.viewportCenter@1');
            positionedPayload = {
              ...payload,
              x: payload.x ?? center.x - DEFAULT_NODE_WIDTH / 2,
              y: payload.y ?? center.y - DEFAULT_NODE_HEIGHT / 2,
            };
          } catch {
            // Headless use and early startup retain the deterministic grid fallback.
          }
        }
        const created = buildCreateTransaction(positionedPayload);
        return { result: { id: created.nodeId }, transaction: created.transaction };
      },
    });

    context.commands.register<ContentMaterializeCopyRequest, { id: string }>({
      type: 'content.materializeCopy',
      validate: (payload): payload is ContentMaterializeCopyRequest => isRecord(payload) &&
        typeof payload.sourceId === 'string' &&
        (payload.title === undefined || typeof payload.title === 'string') &&
        Number.isFinite(payload.x) && Number.isFinite(payload.y),
      handle: async (payload) => {
        const sourceNode = context.store.readValue<TextNodeRecord>(NODE_NAMESPACE, payload.sourceId);
        if (!sourceNode) throw new Error('要放到画布的文本已经不存在');
        const sourceContent = context.store.readValue<TextContentRecord>(CONTENT_NAMESPACE, sourceNode.contentId);
        if (!sourceContent) throw new Error('要放到画布的正文已经不存在');
        const plan = await context.capabilities.request<ContentMutationPlan>(
          'content.clonePlan@1',
          {
            sourceId: payload.sourceId,
            expectedRevision: sourceContent.revision,
            title: payload.title?.trim() || sourceNode.title,
            x: payload.x,
            y: payload.y,
          } satisfies ContentClonePlanRequest,
        );
        return {
          result: { id: plan.nodeId },
          transaction: {
            label: `将“${sourceNode.title}”放到画布`,
            patches: plan.patches,
            events: plan.events,
          },
        };
      },
    });

    context.commands.register<CreateNodePayload, { id: string }>({
      type: 'node.seed',
      validate: (payload): payload is CreateNodePayload => payload === undefined || isRecord(payload),
      handle: (payload = {}) => {
        const created = buildCreateTransaction({ ...payload, history: false });
        return { result: { id: created.nodeId }, transaction: created.transaction };
      },
    });

    context.commands.register<MoveNodePayload>({
      type: 'node.move',
      validate: isMovePayload,
      handle: async (payload) => {
        const node = context.store.readValue<TextNodeRecord>(NODE_NAMESPACE, payload.id);
        if (!node) throw new Error(`Text node not found: ${payload.id}`);
        const next = { ...node, x: payload.x, y: payload.y, revision: node.revision + 1, updatedAt: Date.now() };
        return {
          transaction: {
            label: '移动文本节点',
            patches: [
              { op: 'set', domain: 'document', namespace: NODE_NAMESPACE, key: node.id, value: next },
            ],
            events: [{ type: 'node.moved', payload: { id: node.id, x: next.x, y: next.y } }],
          },
        };
      },
    });

    context.commands.register<MoveManyPayload>({
      type: 'node.moveMany',
      validate: isMoveManyPayload,
      handle: (payload) => {
        const plan = buildMovePlan(context, payload.positions);
        return {
          transaction: {
            label: payload.positions.length > 1 ? `移动 ${payload.positions.length} 个节点` : '移动文本节点',
            patches: plan.patches,
            events: plan.events,
          },
        };
      },
    });

    const resizeNode = (
      id: string,
      widthInput: number,
      heightInput: number,
      label: string,
      expectedRevision?: number,
    ) => {
      const node = context.store.readValue<TextNodeRecord>(NODE_NAMESPACE, id);
      if (!node) throw new Error(`Text node not found: ${id}`);
      if (expectedRevision !== undefined && expectedRevision !== node.revision) {
        throw new Error(`节点“${node.title}”尺寸已经变化，请重新调整`);
      }
      const resized = withRememberedNodeSize(node, widthInput, heightInput);
      const width = resized.width;
      const height = nodeHeight(resized);
      if (node.width === width && nodeHeight(node) === height) {
        return { result: { width, height, revision: node.revision } };
      }
      const next: TextNodeRecord = {
        ...resized,
        revision: node.revision + 1,
        updatedAt: Date.now(),
      };
      return {
        result: { width, height, revision: next.revision },
        transaction: {
          label,
          patches: [{ op: 'set' as const, domain: 'document' as const, namespace: NODE_NAMESPACE, key: node.id, value: next }],
          events: [{ type: 'node.resized', payload: { id: node.id, width, height } }],
        },
      };
    };

    context.commands.register<ResizeNodePayload, { width: number; height: number; revision: number }>({
      type: 'node.resize',
      validate: isResizePayload,
      handle: (payload) => resizeNode(
        payload.id,
        payload.width,
        payload.height,
        '调整文本节点大小',
        payload.expectedRevision,
      ),
    });

    context.commands.register<ResetNodeSizePayload, { width: number; height: number; revision: number }>({
      type: 'node.resetSize',
      validate: (payload): payload is ResetNodeSizePayload => isRecord(payload) && typeof payload.id === 'string',
      handle: (payload) => {
        const node = context.store.readValue<TextNodeRecord>(NODE_NAMESPACE, payload.id);
        if (!node) throw new Error(`Text node not found: ${payload.id}`);
        const size = defaultNodeSize(nodePresentation(node));
        return resizeNode(payload.id, size.width, size.height, '恢复文本节点初始大小');
      },
    });

    context.commands.register({
      type: 'node.resetSelectedSizes',
      handle: async () => {
        let selection: SelectionSnapshot;
        try {
          selection = await context.capabilities.request<SelectionSnapshot>('selection.read@1');
        } catch {
          return { result: { changed: 0 } };
        }
        const nodes = readNodes();
        const changed = selection.ids
          .map((id) => nodes[id])
          .filter((node): node is TextNodeRecord => Boolean(node))
          .flatMap((node) => {
            const size = defaultNodeSize(nodePresentation(node));
            if (node.width === size.width && nodeHeight(node) === size.height) return [];
            return [{
              ...withRememberedNodeSize(node, size.width, size.height),
              revision: node.revision + 1,
              updatedAt: Date.now(),
            }];
          });
        if (changed.length === 0) return { result: { changed: 0 } };
        return {
          result: { changed: changed.length },
          transaction: {
            label: `恢复 ${changed.length} 个文本节点的初始大小`,
            patches: changed.map((node) => ({
              op: 'set' as const,
              domain: 'document' as const,
              namespace: NODE_NAMESPACE,
              key: node.id,
              value: node,
            })),
            events: changed.map((node) => ({
              type: 'node.resized',
              payload: { id: node.id, width: node.width, height: node.height },
            })),
          },
        };
      },
    });

    context.capabilities.provide<GridArrangePlanRequest, GridArrangePlan>({
      key: 'layout.gridPlan@1',
      invoke: (input) => {
        if (!input || !Array.isArray(input.nodeIds) ||
          input.nodeIds.some((id) => typeof id !== 'string')) {
          throw new Error('自动排列计划请求不正确');
        }
        const storedNodes = readNodes();
        const selectedNodes = [...new Set(input.nodeIds)]
          .map((id) => storedNodes[id])
          .filter((node): node is TextNodeRecord => Boolean(node));
        const mode = input.mode ?? (input.direction === 'vertical' ? 'vertical' : 'grid');
        const layout = arrangeNodesInGrid(selectedNodes, mode);
        if (selectedNodes.length === 0) {
          return { selected: 0, changed: 0, columns: layout.columns, patches: [] };
        }
        const positions = new Map(layout.positions.map((position) => [position.id, position]));
        const updatedAt = Date.now();
        const changed = selectedNodes.flatMap((node) => {
          const position = positions.get(node.id)!;
          if (
            node.x === position.x && node.y === position.y &&
            node.width === DEFAULT_NODE_WIDTH && nodeHeight(node) === DEFAULT_NODE_HEIGHT
          ) return [];
          return [{
            previous: node,
            next: {
              ...withRememberedNodeSize(node, DEFAULT_NODE_WIDTH, DEFAULT_NODE_HEIGHT),
              x: position.x,
              y: position.y,
              revision: node.revision + 1,
              updatedAt,
            } satisfies TextNodeRecord,
          }];
        });
        if (changed.length === 0) {
          return { selected: selectedNodes.length, changed: 0, columns: layout.columns, patches: [] };
        }
        return {
          selected: selectedNodes.length,
          changed: changed.length,
          columns: layout.columns,
          patches: changed.map(({ next }) => ({
            op: 'set' as const,
            domain: 'document' as const,
            namespace: NODE_NAMESPACE,
            key: next.id,
            value: next,
            schemaOwner: 'text-node',
          })),
          events: [
            { type: 'nodes.moved', payload: { positions: layout.positions } },
            ...changed
              .filter(({ previous }) =>
                previous.width !== DEFAULT_NODE_WIDTH || nodeHeight(previous) !== DEFAULT_NODE_HEIGHT)
              .map(({ next }) => ({
                type: 'node.resized',
                payload: { id: next.id, width: next.width, height: next.height },
              })),
          ],
        };
      },
    });

    context.commands.register<SetNodePresentationRequest, SetNodePresentationResult>({
      type: 'node.presentation.set',
      validate: (payload): payload is SetNodePresentationRequest =>
        isRecord(payload) && typeof payload.id === 'string' &&
        (payload.presentation === 'card' || payload.presentation === 'text-box') &&
        (payload.expectedRevision === undefined || Number.isInteger(payload.expectedRevision)),
      handle: (payload) => {
        const node = context.store.readValue<TextNodeRecord>(NODE_NAMESPACE, payload.id);
        if (!node) throw new Error(`Text node not found: ${payload.id}`);
        if (payload.expectedRevision !== undefined && payload.expectedRevision !== node.revision) {
          throw new Error(`节点“${node.title}”显示方式已经变化，请重试`);
        }
        const current = nodePresentation(node);
        if (current === payload.presentation) {
          return {
            result: {
              presentation: current,
              width: node.width,
              height: nodeHeight(node),
              revision: node.revision,
            },
          };
        }
        const rememberedCurrent = withRememberedNodeSize(node, node.width, nodeHeight(node));
        const targetSize = rememberedNodeSize(rememberedCurrent, payload.presentation);
        const next: TextNodeRecord = {
          ...rememberedCurrent,
          presentation: payload.presentation,
          width: targetSize.width,
          height: targetSize.height,
          revision: node.revision + 1,
          updatedAt: Date.now(),
        };
        return {
          result: {
            presentation: payload.presentation,
            width: next.width,
            height: nodeHeight(next),
            revision: next.revision,
          },
          transaction: {
            label: payload.presentation === 'text-box' ? '转换为文本框' : '转换为文本节点',
            patches: [{
              op: 'set',
              domain: 'document',
              namespace: NODE_NAMESPACE,
              key: node.id,
              value: next,
            }],
            events: [{
              type: 'node.presentation.changed',
              payload: {
                id: node.id,
                presentation: payload.presentation,
                width: next.width,
                height: nodeHeight(next),
              },
            }],
          },
        };
      },
    });

    context.commands.register<undefined, { changed: number }>({
      type: 'node.toggleSelectedPresentation',
      handle: async () => {
        let selection: SelectionSnapshot;
        try {
          selection = await context.capabilities.request<SelectionSnapshot>('selection.read@1');
        } catch {
          return { result: { changed: 0 } };
        }
        const nodes = readNodes();
        const updatedAt = Date.now();
        const changed = selection.ids.flatMap((id) => {
          const node = nodes[id];
          if (!node) return [];
          const current = nodePresentation(node);
          const presentation = current === 'card' ? 'text-box' : 'card';
          const rememberedCurrent = withRememberedNodeSize(node, node.width, nodeHeight(node));
          const targetSize = rememberedNodeSize(rememberedCurrent, presentation);
          return [{
            ...rememberedCurrent,
            presentation,
            width: targetSize.width,
            height: targetSize.height,
            revision: node.revision + 1,
            updatedAt,
          } satisfies TextNodeRecord];
        });
        if (changed.length === 0) return { result: { changed: 0 } };
        return {
          result: { changed: changed.length },
          transaction: {
            label: changed.length === 1 ? '切换文本节点显示方式' : `切换 ${changed.length} 个文本节点显示方式`,
            patches: changed.map((node) => ({
              op: 'set' as const,
              domain: 'document' as const,
              namespace: NODE_NAMESPACE,
              key: node.id,
              value: node,
            })),
            events: changed.map((node) => ({
              type: 'node.presentation.changed',
              payload: {
                id: node.id,
                presentation: nodePresentation(node),
                width: node.width,
                height: nodeHeight(node),
              },
            })),
          },
        };
      },
    });

    context.commands.register<RenameNodePayload>({
      type: 'node.rename',
      validate: (payload): payload is RenameNodePayload =>
        isRecord(payload) && typeof payload.id === 'string' && typeof payload.title === 'string',
      handle: async (payload) => {
        const node = context.store.readValue<TextNodeRecord>(NODE_NAMESPACE, payload.id);
        if (!node) throw new Error(`Text node not found: ${payload.id}`);
        const title = normalizeNodeTitle(payload.title);
        if (title === node.title) return { result: { title: node.title, revision: node.revision } };
        if (isNodeTitleTaken(title, readNodeIndex().nodes, node.id)) {
          throw new Error(`标题“${title}”已经存在，请重新命名`);
        }
        const plan = await planNodeRename(node, title);
        return {
          result: { title: plan.resolvedTitle, revision: plan.nodeRevision },
          transaction: {
            label: '修改节点标题',
            mergeKey: `title:${node.id}`,
            patches: plan.patches,
            events: plan.events,
          },
        };
      },
    });

    context.commands.register({
      type: 'content.applyDelta',
      validate: isDeltaPayload,
      handle: async (payload) => {
        const node = context.store.readValue<TextNodeRecord>(NODE_NAMESPACE, payload.nodeId);
        if (!node) throw new Error(`Text node not found: ${payload.nodeId}`);
        const content = context.store.readValue<TextContentRecord>(CONTENT_NAMESPACE, node.contentId);
        if (!content) throw new Error(`Content not found: ${node.contentId}`);
        if (payload.expectedRevision !== undefined && payload.expectedRevision !== content.revision) {
          throw new Error(`节点“${node.title}”正文版本已变化，请重新同步后编辑`);
        }
        if (payload.start < 0 || payload.start > content.length) {
          throw new Error('正文修改起点已经超出当前内容范围，请重新同步后编辑');
        }
        if (payload.deleteCount < 0 || payload.start + payload.deleteCount > content.length) {
          throw new Error('正文删除范围已经超出当前内容范围，请重新同步后编辑');
        }
        if (content.length - payload.deleteCount + payload.insert.length > MAX_DOCUMENT_LENGTH) {
          throw new Error('单个正文当前最多支持 3200 万 UTF-16 字符');
        }
        const mutation = planContentDelta(
          context,
          content,
          payload.start,
          payload.deleteCount,
          payload.insert,
        );
        const formatMutation = planFormattingEdits(context, node.id, [{
          start: payload.start,
          deleteCount: payload.deleteCount,
          insertLength: payload.insert.length,
        }], payload.inheritFormat && payload.insert.length > 0 ? {
          start: payload.start,
          length: payload.insert.length,
          format: payload.inheritFormat,
        } : undefined);
        const anchorPlans = await planExternalAnchors({
          nodeId: node.id,
          start: payload.start,
          deleteCount: payload.deleteCount,
          insertLength: payload.insert.length,
        });
        const clonePlans = payload.annotationCopies && payload.annotationCopies.length > 0
          ? await planExternalAnnotationClones({
              nodeId: node.id,
              insertionStart: payload.start,
              insertionLength: payload.insert.length,
              items: payload.annotationCopies,
            })
          : [];
        const nextContent = mutation.content;
        const nextNode = { ...node, revision: node.revision + 1, updatedAt: Date.now() };
        return {
          result: {
            revision: nextContent.revision,
            length: nextContent.length,
            formatRevision: formatMutation.revision,
          },
          transaction: {
            label: '编辑正文',
            mergeKey: `typing:${node.id}:${payload.typingSessionId ?? 'default'}`,
            mergeWindowMs: 1400,
            patches: [
              ...mutation.chunkPatches,
              {
                op: 'set',
                domain: 'document',
                namespace: CONTENT_NAMESPACE,
                key: content.id,
                value: nextContent,
              },
              {
                op: 'set',
                domain: 'document',
                namespace: NODE_NAMESPACE,
                key: node.id,
                value: nextNode,
              },
              ...formatMutation.patches,
              ...anchorPlans.flatMap((plan) => plan.patches),
              ...clonePlans.flatMap((plan) => plan.patches),
            ],
            events: [
              {
                type: 'content.changed',
                payload: { nodeId: node.id, revision: nextContent.revision, length: nextContent.length },
              },
              ...(formatMutation.revision === undefined ? [] : [{
                type: 'content.format.changed',
                payload: { nodeId: node.id, revision: formatMutation.revision },
              }]),
              ...anchorPlans.flatMap((plan) => plan.events ?? []),
              ...clonePlans.flatMap((plan) => plan.events ?? []),
            ],
          },
        };
      },
    });

    context.commands.register({
      type: 'content.moveRange',
      validate: isMoveRangePayload,
      handle: async (payload) => {
        const node = context.store.readValue<TextNodeRecord>(NODE_NAMESPACE, payload.nodeId);
        if (!node) throw new Error(`Text node not found: ${payload.nodeId}`);
        const content = context.store.readValue<TextContentRecord>(CONTENT_NAMESPACE, node.contentId);
        if (!content) throw new Error(`Content not found: ${node.contentId}`);
        if (payload.expectedRevision !== undefined && payload.expectedRevision !== content.revision) {
          throw new Error(`节点“${node.title}”正文版本已变化，请重新同步后移动文字`);
        }
        if (payload.start < 0 || payload.end <= payload.start || payload.end > content.length) {
          throw new Error('要移动的正文范围无效，请重新选择文字');
        }
        if (payload.target < 0 || payload.target > content.length) {
          throw new Error('文字移动目标已经超出当前正文范围');
        }
        if (payload.target >= payload.start && payload.target <= payload.end) {
          return { result: { revision: content.revision, length: content.length } };
        }
        const mutation = planContentMove(
          context,
          content,
          payload.start,
          payload.end,
          payload.target,
        );
        const formatMutation = planFormattingMove(
          context,
          node.id,
          payload.start,
          payload.end,
          payload.target,
        );
        const anchorPlans = await planExternalAnchorMove(payload);
        const nextNode = { ...node, revision: node.revision + 1, updatedAt: Date.now() };
        return {
          result: {
            revision: mutation.content.revision,
            length: mutation.content.length,
            formatRevision: formatMutation.revision,
          },
          transaction: {
            label: '移动正文选区',
            patches: [
              ...mutation.chunkPatches,
              {
                op: 'set',
                domain: 'document',
                namespace: CONTENT_NAMESPACE,
                key: content.id,
                value: mutation.content,
              },
              {
                op: 'set',
                domain: 'document',
                namespace: NODE_NAMESPACE,
                key: node.id,
                value: nextNode,
              },
              ...formatMutation.patches,
              ...anchorPlans.flatMap((plan) => plan.patches),
            ],
            events: [
              {
                type: 'content.changed',
                payload: { nodeId: node.id, revision: mutation.content.revision, length: mutation.content.length },
              },
              ...(formatMutation.revision === undefined ? [] : [{
                type: 'content.format.changed',
                payload: { nodeId: node.id, revision: formatMutation.revision },
              }]),
              ...anchorPlans.flatMap((plan) => plan.events ?? []),
            ],
          },
        };
      },
    });

    context.commands.register<undefined, { migrated: number }>({
      type: 'content.migrateStorage',
      handle: () => {
        const patches: PatchOperation[] = [];
        let migrated = 0;
        for (const content of Object.values(readContents())) {
          if (isVersionTwoContent(content)) continue;
          const legacyChunks = Array.isArray(content.chunks) ? content.chunks : [''];
          const created = createContentStorage(content.id, legacyChunks.join(''), content.revision);
          patches.push(...created.chunkPatches, {
            op: 'set',
            domain: 'document',
            namespace: CONTENT_NAMESPACE,
            key: content.id,
            value: created.content,
          });
          migrated += 1;
        }
        for (const node of Object.values(readNodes())) {
          const legacyNode = node as TextNodeRecord & { private?: unknown };
          if (Object.prototype.hasOwnProperty.call(legacyNode, 'private')) {
            const cleanNode = { ...legacyNode };
            delete cleanNode.private;
            patches.push({
              op: 'set',
              domain: 'document',
              namespace: NODE_NAMESPACE,
              key: node.id,
              value: cleanNode satisfies TextNodeRecord,
            });
            migrated += 1;
          }
          const format = context.store.readValue<TextFormatRecord>(FORMAT_NAMESPACE, node.id);
          if (!format || format.storageVersion === 2) continue;
          patches.push({
            op: 'set',
            domain: 'document',
            namespace: FORMAT_NAMESPACE,
            key: node.id,
            value: { ...format, storageVersion: 2, markIds: [] } satisfies TextFormatRecord,
          });
          migrated += 1;
        }
        return {
          result: { migrated },
          transaction: {
            label: '升级文本节点数据',
            history: false,
            patches,
            events: migrated > 0 ? [{ type: 'content.storage.migrated', payload: { migrated } }] : [],
          },
        };
      },
    });

    context.commands.register({
      type: 'content.setDocumentFormat',
      validate: isSetDocumentFormatRequest,
      handle: (payload) => {
        const node = context.store.readValue<TextNodeRecord>(NODE_NAMESPACE, payload.nodeId);
        if (!node) throw new Error(`Text node not found: ${payload.nodeId}`);
        const current = readFormatRecord(context, node.id);
        if (payload.expectedRevision !== current.revision) {
          throw new Error(`节点“${node.title}”格式版本已变化，请重新同步后设置`);
        }
        const next: TextFormatRecord = {
          nodeId: node.id,
          revision: current.revision + 1,
          format: validateDocumentFormat({ ...current.format, ...payload.patch }),
        };
        return {
          result: toFormatSnapshot(next),
          transaction: {
            label: '修改正文格式',
            mergeKey: `format:${node.id}`,
            mergeWindowMs: 900,
            patches: [
              {
                op: 'set',
                domain: 'document',
                namespace: FORMAT_NAMESPACE,
                key: node.id,
                value: next,
              },
            ],
            events: [
              {
                type: 'content.format.changed',
                payload: { nodeId: node.id, revision: next.revision },
              },
            ],
          },
        };
      },
    });

    context.commands.register({
      type: 'content.setRangeFormat',
      validate: isSetRangeFormatRequest,
      handle: (payload) => {
        const node = context.store.readValue<TextNodeRecord>(NODE_NAMESPACE, payload.nodeId);
        if (!node) throw new Error(`Text node not found: ${payload.nodeId}`);
        const content = context.store.readValue<TextContentRecord>(CONTENT_NAMESPACE, node.contentId);
        if (!content) throw new Error(`Content not found: ${node.contentId}`);
        const current = readFormatRecord(context, node.id);
        if (payload.expectedRevision !== current.revision) {
          throw new Error(`节点“${node.title}”格式版本已变化，请重新同步后设置`);
        }
        if (payload.expectedContentRevision !== content.revision) {
          throw new Error(`节点“${node.title}”正文版本已变化，请重新选择后设置格式`);
        }
        if (payload.start < 0 || payload.end > content.length || payload.start >= payload.end) {
          throw new Error('格式选区必须是正文内的非空范围');
        }
        const markIds = current.markIds ?? [];
        if (markIds.length >= MAX_FORMAT_MARKS_PER_NODE) {
          throw new Error(`单个节点最多保留 ${MAX_FORMAT_MARKS_PER_NODE} 个格式区间`);
        }
        const normalizedPatch = validateFormatPatch(payload.patch);
        const existing = markIds
          .map((id) => context.store.readValue<TextFormatMark>(FORMAT_MARK_NAMESPACE, id))
          .find((mark) => mark?.scope === payload.scope && mark.start.offset === payload.start &&
            mark.end.offset === payload.end);
        const mark: TextFormatMark = existing ? {
          ...existing,
          format: { ...existing.format, ...normalizedPatch },
          revision: existing.revision + 1,
        } : {
          id: createId('format-mark'),
          nodeId: node.id,
          scope: payload.scope,
          start: { offset: payload.start, bias: 'after' },
          end: { offset: payload.end, bias: 'before' },
          format: normalizedPatch,
          revision: 1,
        };
        const next: TextFormatRecord = {
          ...current,
          storageVersion: 2,
          markIds: existing ? markIds : [...markIds, mark.id],
          revision: current.revision + 1,
        };
        const snapshot = toFormattingSnapshot(context, next, content, 0, content.length, [
          ...readFormatMarks(context, current).filter((item) => item.id !== mark.id),
          mark,
        ]);
        return {
          result: snapshot,
          transaction: {
            label: payload.scope === 'paragraph' ? '修改段落格式' : '修改选区格式',
            mergeKey: `format-range:${node.id}:${payload.scope}:${payload.start}:${payload.end}`,
            mergeWindowMs: 900,
            patches: [
              { op: 'set', domain: 'document', namespace: FORMAT_MARK_NAMESPACE, key: mark.id, value: mark },
              { op: 'set', domain: 'document', namespace: FORMAT_NAMESPACE, key: node.id, value: next },
            ],
            events: [{
              type: 'content.format.changed',
              payload: { nodeId: node.id, revision: next.revision },
            }],
          },
        };
      },
    });

    context.queries.register({
      type: 'textNode.count',
      handle: () => Object.values(readNodes()).filter(isCanvasTextNode).length,
    });

    registerTextNodeCapabilities({
      context,
      readNodes,
      readNodeIndex,
      titleAllocator,
      planExternalAnchors,
      readContents,
      statisticsCache,
      getCatalogVersion: () => catalogVersion,
      catalogChanges,
      readSummaries,
      buildCreateTransaction,
      planNodeRename,
    });

    if (canvasLayer) context.ui.contribute({
      id: 'text-node.canvas-layer',
      slot: 'canvas.entities',
      kind: 'view',
      label: '文本节点画布层',
      component: canvasLayer,
      priority: 10,
    });
    if (emptyState) context.ui.contribute({
      id: 'text-node.empty-state',
      slot: 'canvas.empty',
      kind: 'view',
      label: '空白画布引导',
      component: emptyState,
      priority: 10,
    });

    context.ui.contribute({
      id: 'text-node.create',
      slot: 'top.primary',
      kind: 'button',
      label: '新建文本',
      icon: 'add',
      tone: 'primary',
      group: 'create',
      tooltip: '创建文本节点（Ctrl/⌘ + Enter）',
      command: 'node.create',
      priority: 10,
    });
    context.ui.contribute({
      id: 'text-node.toggle-selected-presentation',
      slot: 'top.primary',
      kind: 'button',
      label: '文本框与文字节点相互转换',
      tooltip: '文本框与文字节点相互转换',
      icon: 'replace',
      tone: 'primary',
      group: 'appearance',
      command: 'node.toggleSelectedPresentation',
      priority: 30,
    });
    context.ui.shortcut({
      id: 'text-node.create-shortcut',
      chord: 'mod+enter',
      command: 'node.create',
      label: '创建文本节点',
    });
    context.ui.shortcut({
      id: 'text-node.reset-selected-sizes-shortcut',
      command: 'node.resetSelectedSizes',
      label: '选中文本节点恢复初始大小',
      category: '文本节点',
    });
    context.ui.shortcut({
      id: 'text-node.toggle-selected-presentation-shortcut',
      command: 'node.toggleSelectedPresentation',
      label: '文本框与文字节点相互转换',
      category: '文本节点',
    });
    context.ui.action({
      id: 'text-node.create-action',
      label: '创建文本节点',
      command: 'node.create',
      category: '画布',
      keywords: ['新建', '正文', '文本', 'node'],
      priority: 10,
    });
    context.ui.action({
      id: 'text-node.toggle-selected-presentation-action',
      label: '文本框与文字节点相互转换',
      command: 'node.toggleSelectedPresentation',
      category: '文本节点',
      keywords: ['文本框', '文字节点', '文本节点', '转换', '切换'],
      priority: 20,
    });

    const catalogIds = (payload: unknown): string[] => {
      if (!isRecord(payload)) return [];
      if (typeof payload.id === 'string') return [payload.id];
      if (typeof payload.nodeId === 'string') return [payload.nodeId];
      if (Array.isArray(payload.ids)) return payload.ids.filter((id): id is string => typeof id === 'string');
      if (Array.isArray(payload.nodeIds)) return payload.nodeIds.filter((id): id is string => typeof id === 'string');
      if (Array.isArray(payload.positions)) return payload.positions.flatMap((position) =>
        isRecord(position) && typeof position.id === 'string' ? [position.id] : []);
      return [];
    };
    for (const event of [
      'node.created',
      'node.moved',
      'nodes.moved',
      'node.resized',
      'node.presentation.changed',
      'nodes.deleted',
      'nodes.pasted',
    ]) {
      context.events.subscribe(event, (message) => invalidateCatalog(catalogIds(message.payload), false, true));
    }
    for (const event of [
      'node.renamed',
      'node.appearance.changed',
      'node.placement.changed',
      'content.changed',
      'content.format.changed',
    ]) {
      context.events.subscribe(event, (message) => invalidateCatalog(catalogIds(message.payload)));
    }
    context.events.subscribe('history.changed', () => invalidateCatalog(undefined, true, true));
    context.events.subscribe('document.replaced', () => invalidateCatalog(undefined, true, true));

    const migrateStorageAfterEvent = () => {
      void context.commands.dispatch('content.migrateStorage').catch((error) => {
        context.diagnostics.error('超长正文分块迁移失败', error);
      });
    };
    context.events.subscribe('document.replaced', migrateStorageAfterEvent);
    await context.commands.dispatch('content.migrateStorage');

    if (Object.values(readNodes()).filter(isCanvasTextNode).length === 0) {
      for (const seed of ONBOARDING_NODE_SEEDS) {
        await context.commands.dispatch('node.seed', seed);
      }
    }
  },
  };
}

/** Headless composition used by contract tests and non-React hosts. */
export const textNodePlugin = createTextNodePlugin();
