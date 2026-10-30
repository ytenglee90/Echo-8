import {
  createId,
  isRecord,
  type PatchOperation,
  type PluginContext,
} from '../../core/contracts.ts';
import type {
  AIContextCatalogContribution,
  AIContextReadContribution,
  AIContextReadRequest,
  AIContextSearchContribution,
  AIContextSearchRequest,
} from '../../protocols/ai.ts';
import type {
  ClipboardFragment,
  ClipboardInstantiateInput,
  ClipboardInstantiatePlan,
} from '../../protocols/clipboard.ts';
import type {
  ContentAppendPlanRequest,
  ContentCatalogDelta,
  ContentCatalogRequest,
  ContentClonePlanRequest,
  ContentCreatePlanRequest,
  ContentDeltaPlanRequest,
  ContentMetricsRequest,
  ContentMetricsSnapshot,
  ContentMetricsSnapshotV2,
  ContentMetricsSnapshotV3,
  ContentMovePlan,
  ContentMovePlanRequest,
  ContentMutationPlan,
  ContentPlacementPlanRequest,
  ContentRenamePlan,
  ContentRenamePlanRequest,
  ContentStorageInfo,
  ContentStorageInfoRequest,
  ContentSummariesRequest,
  ContentSummary,
} from '../../protocols/content.ts';
import type {
  ContentAnchorTransformPlan,
  ContentAnchorTransformRequest,
} from '../../protocols/annotations.ts';
import type {
  AppearanceColorContribution,
  AppearanceReadContribution,
  AppearanceReadRequest,
  AppearanceUpdatePlan,
  AppearanceUpdateRequest,
} from '../../protocols/appearance.ts';
import {
  DEFAULT_TEXT_DOCUMENT_FORMAT,
  type TextFormatSnapshot,
  type TextFormattingRequest,
  type TextFormattingSnapshot,
} from '../../protocols/formatting.ts';
import type {
  ContentReplacePlan,
  ContentReplaceRequest,
  ContentSearchRequest,
  ContentSearchResult,
  ContentSearchResultV2,
  SearchHit,
  SearchHitV2,
} from '../../protocols/search.ts';
import type {
  EntityDeletePlan,
  SelectionCatalogContribution,
} from '../../protocols/selection.ts';
import type { ContentStatistics } from '../../protocols/statistics.ts';
import {
  createNodeTitleAllocator,
  isNodeTitleTaken,
  nodeTitleKey,
  normalizeNodeTitle,
} from './title-policy.ts';
import {
  CHUNK_SIZE,
  CONTENT_CHUNK_NAMESPACE,
  MAX_DOCUMENT_LENGTH,
  contentChunkIds,
  contentChunkLengths,
  createContentStorageFromChunks,
  planContentDelta,
  planContentSubstitutions,
  readAllContentChunks,
  readContentChunk,
  readContentRange,
  readRange,
  type TextContentChunkRecord,
  type ContentSubstitution,
  type TextContentRecord,
} from './content-storage.ts';
import {
  findLinkedTitleHits,
  isReferenceTitle,
  MAX_TITLE_REFERENCE_REPLACEMENTS,
} from './title-reference-sync.ts';
import {
  FORMAT_MARK_NAMESPACE,
  FORMAT_NAMESPACE,
  planFormattingEdits,
  readFormatMarks,
  readFormatRecord,
  toFormatSnapshot,
  toFormattingSnapshot,
  validateDocumentFormat,
  type TextFormatRecord,
} from './formatting-storage.ts';
import {
  CONTENT_NAMESPACE,
  NODE_NAMESPACE,
  assertNotAborted,
  buildMovePlan,
  buildTextColorPlan,
  buildTitleColorPlan,
  contentStatisticsSignature,
  countContentChunks,
  defaultNodeTitleColor,
  isCanvasTextNode,
  isMoveManyPayload,
  isSerializedTextNodes,
  nodeHeight,
  searchChunks,
  searchContextNodes,
  searchNodeTitle,
  toContextSource,
  validateAppearanceUpdate,
  validateSearchRequest,
  yieldToMainThread,
  type CreateNodePayload,
  type SerializedTextNodes,
  type TextNodeRecord,
} from './operations.ts';

interface NodeIndexSnapshot {
  nodes: TextNodeRecord[];
}

function rangesOverlap(
  leftStart: number,
  leftLength: number,
  rightStart: number,
  rightLength: number,
): boolean {
  return leftStart < rightStart + rightLength && rightStart < leftStart + leftLength;
}

interface ContentStatisticsCacheEntry {
  signature: string;
  graphemes: number;
  nonWhitespaceGraphemes: number;
  writingUnits: number;
  words: number;
  lines: number;
}

interface CreateTransactionResult {
  nodeId: string;
  resolvedTitle: string;
  transaction: {
    patches: PatchOperation[];
    events?: Array<{ type: string; payload: unknown }>;
  };
}

export interface TextNodeCapabilityRuntime {
  context: PluginContext;
  readNodes: () => Record<string, TextNodeRecord>;
  readNodeIndex: () => NodeIndexSnapshot;
  titleAllocator: (reservedTitles: Iterable<string>) => ReturnType<typeof createNodeTitleAllocator>;
  planExternalAnchors: (
    input: ContentAnchorTransformRequest,
  ) => Promise<ContentAnchorTransformPlan[]>;
  readContents: () => Record<string, TextContentRecord>;
  statisticsCache: Map<string, ContentStatisticsCacheEntry>;
  getCatalogVersion: () => number;
  catalogChanges: Array<{ version: number; ids?: string[]; reset?: true }>;
  readSummaries: (ids?: Iterable<string>, includeSystem?: boolean) => ContentSummary[];
  buildCreateTransaction: (
    payload: CreateNodePayload,
    reservedTitles?: Iterable<string>,
  ) => CreateTransactionResult;
  planNodeRename: (node: TextNodeRecord, title: string) => Promise<ContentRenamePlan>;
}

export function registerTextNodeCapabilities({
  context,
  readNodes,
  readNodeIndex,
  titleAllocator,
  planExternalAnchors,
  readContents,
  statisticsCache,
  getCatalogVersion,
  catalogChanges,
  readSummaries,
  buildCreateTransaction,
  planNodeRename,
}: TextNodeCapabilityRuntime): void {
    context.capabilities.provide({
      key: 'content.summaries@1',
      invoke: () => readSummaries(),
    });
    context.capabilities.provide<ContentCatalogRequest | undefined, ContentCatalogDelta>({
      key: 'content.catalog@2',
      invoke: (input) => {
        const rawInput: unknown = input;
        if (rawInput !== undefined && (!isRecord(rawInput) ||
          (rawInput.sinceVersion !== undefined && (typeof rawInput.sinceVersion !== 'number' ||
            !Number.isInteger(rawInput.sinceVersion) || rawInput.sinceVersion < 0)))) {
          throw new Error('正文目录增量版本不正确');
        }
        const sinceVersion = isRecord(rawInput) && typeof rawInput.sinceVersion === 'number'
          ? rawInput.sinceVersion
          : undefined;
        const oldestVersion = catalogChanges[0]?.version ?? getCatalogVersion() + 1;
        const changes = sinceVersion === undefined
          ? []
          : catalogChanges.filter((change) => change.version > sinceVersion);
        const reset = sinceVersion === undefined || sinceVersion > getCatalogVersion() ||
          sinceVersion < oldestVersion - 1 || changes.some((change) => change.reset);
        if (reset) {
          return { version: getCatalogVersion(), reset: true, summaries: readSummaries(), removedIds: [] };
        }
        const ids = [...new Set(changes.flatMap((change) => change.ids ?? []))];
        const summaries = readSummaries(ids);
        const existing = new Set(summaries.map((summary) => summary.id));
        return {
          version: getCatalogVersion(),
          reset: false,
          summaries,
          removedIds: ids.filter((id) => !existing.has(id)),
        };
      },
    });
    context.capabilities.provide<ContentMetricsRequest, ContentMetricsSnapshot>({
      key: 'content.metrics@1',
      invoke: (input) => {
        if (!input || !Array.isArray(input.nodeIds) ||
          input.nodeIds.some((id) => typeof id !== 'string')) {
          throw new Error('正文指标请求不正确');
        }
        const nodes = readNodes();
        const contents = readContents();
        let nodeCount = 0;
        let utf16Units = 0;
        for (const id of new Set(input.nodeIds)) {
          const node = nodes[id];
          if (node && !isCanvasTextNode(node)) continue;
          const content = node ? contents[node.contentId] : undefined;
          if (!content) continue;
          nodeCount += 1;
          utf16Units += content.length;
        }
        return { nodeCount, utf16Units };
      },
    });
    const readExactContentMetrics = async (
      input: ContentMetricsRequest,
      signal?: AbortSignal,
    ): Promise<ContentMetricsSnapshotV3> => {
        if (!input || !Array.isArray(input.nodeIds) ||
          input.nodeIds.some((id) => typeof id !== 'string')) {
          throw new Error('正文精确指标请求不正确');
        }
        const nodes = readNodes();
        const contents = readContents();
        const result: ContentMetricsSnapshotV3 = {
          nodeCount: 0,
          utf16Units: 0,
          graphemes: 0,
          nonWhitespaceGraphemes: 0,
          writingUnits: 0,
          byNode: {},
        };
        for (const id of new Set(input.nodeIds)) {
          assertNotAborted(signal);
          const node = nodes[id];
          if (!node || !isCanvasTextNode(node)) continue;
          const content = contents[node.contentId];
          if (!content) continue;
          const signature = contentStatisticsSignature(content);
          let counts = statisticsCache.get(content.id);
          if (!counts || counts.signature !== signature) {
            counts = { signature, ...await countContentChunks(context, content, signal) };
            statisticsCache.set(content.id, counts);
          }
          result.nodeCount += 1;
          result.utf16Units += content.length;
          result.graphemes += counts.graphemes;
          result.nonWhitespaceGraphemes += counts.nonWhitespaceGraphemes;
          result.writingUnits += counts.writingUnits;
          result.byNode[id] = {
            nodeId: id,
            revision: content.revision,
            utf16Units: content.length,
            graphemes: counts.graphemes,
            nonWhitespaceGraphemes: counts.nonWhitespaceGraphemes,
            writingUnits: counts.writingUnits,
          };
        }
        return result;
    };
    context.capabilities.provide<ContentMetricsRequest, ContentMetricsSnapshotV2>({
      key: 'content.metrics@2',
      invoke: readExactContentMetrics,
    });
    context.capabilities.provide<ContentMetricsRequest, ContentMetricsSnapshotV3>({
      key: 'content.metrics@3',
      invoke: readExactContentMetrics,
    });
    context.capabilities.provide<ContentSummariesRequest, ContentSummary[]>({
      key: 'content.summariesById@1',
      invoke: (input) => {
        if (!input || !Array.isArray(input.nodeIds) ||
          input.nodeIds.some((id) => typeof id !== 'string')) {
          throw new Error('正文摘要请求不正确');
        }
        return readSummaries(input.nodeIds, true);
      },
    });

    context.capabilities.provide<undefined, SelectionCatalogContribution>({
      key: 'selection.entities@1',
      invoke: () => ({
        owner: 'text-node',
        entities: Object.values(readNodes()).filter(isCanvasTextNode).map((node) => ({
          id: node.id,
          kind: 'text-node',
          bounds: { x: node.x, y: node.y, width: node.width, height: nodeHeight(node) },
        })),
      }),
    });

    context.capabilities.provide({
      key: 'content.read@1',
      invoke: (input) => {
        if (!isRecord(input) || typeof input.nodeId !== 'string') throw new Error('content.read requires nodeId');
        const start = typeof input.start === 'number' ? input.start : 0;
        const length = typeof input.length === 'number' ? Math.min(input.length, 256 * 1024) : 64 * 1024;
        const node = context.store.readValue<TextNodeRecord>(NODE_NAMESPACE, input.nodeId);
        if (!node) throw new Error(`Text node not found: ${input.nodeId}`);
        const content = context.store.readValue<TextContentRecord>(CONTENT_NAMESPACE, node.contentId);
        if (!content) throw new Error(`Content not found: ${node.contentId}`);
        return {
          nodeId: node.id,
          start,
          text: readContentRange(context, content, start, length),
          totalLength: content.length,
          revision: content.revision,
        };
      },
    });

    context.capabilities.provide<ContentStorageInfoRequest, ContentStorageInfo>({
      key: 'content.storageInfo@1',
      invoke: (input) => {
        if (!input || typeof input.nodeId !== 'string') throw new Error('content.storageInfo requires nodeId');
        const node = context.store.readValue<TextNodeRecord>(NODE_NAMESPACE, input.nodeId);
        if (!node) throw new Error(`Text node not found: ${input.nodeId}`);
        const content = context.store.readValue<TextContentRecord>(CONTENT_NAMESPACE, node.contentId);
        if (!content) throw new Error(`Content not found: ${node.contentId}`);
        const lengths = contentChunkLengths(content);
        return {
          nodeId: node.id,
          revision: content.revision,
          length: content.length,
          storageVersion: 2,
          chunkSize: CHUNK_SIZE,
          chunkCount: lengths.length,
          largestChunk: lengths.reduce((largest, length) => Math.max(largest, length), 0),
        };
      },
    });

    context.capabilities.provide<ContentMovePlanRequest, ContentMovePlan>({
      key: 'content.movePlan@1',
      invoke: (input) => {
        if (!isMoveManyPayload(input)) throw new Error('content.movePlan request is invalid');
        return buildMovePlan(context, input.positions, true);
      },
    });

    context.capabilities.provide<ContentRenamePlanRequest, ContentRenamePlan>({
      key: 'content.renamePlan@1',
      invoke: async (input) => {
        if (!input || typeof input.nodeId !== 'string' || typeof input.title !== 'string' ||
          (input.expectedNodeRevision !== undefined && !Number.isInteger(input.expectedNodeRevision)) ||
          (input.reservedTitles !== undefined && (!Array.isArray(input.reservedTitles) ||
            input.reservedTitles.some((title) => typeof title !== 'string')))) {
          throw new Error('content.renamePlan request is invalid');
        }
        const node = context.store.readValue<TextNodeRecord>(NODE_NAMESPACE, input.nodeId);
        if (!node) throw new Error(`Text node not found: ${input.nodeId}`);
        if (input.expectedNodeRevision !== undefined && input.expectedNodeRevision !== node.revision) {
          throw new Error(`节点“${node.title}”标题版本已经变化，请重新命名`);
        }
        const title = normalizeNodeTitle(input.title);
        const occupied = [
          ...readNodeIndex().nodes.filter((candidate) => candidate.id !== node.id),
          ...(input.reservedTitles ?? []).map((reservedTitle, index) => ({
            id: `reserved:${index}`,
            title: reservedTitle,
          })),
        ];
        if (isNodeTitleTaken(title, occupied)) {
          throw new Error(`标题“${title}”已经存在，请重新命名`);
        }
        if (title === node.title) {
          return { nodeId: node.id, nodeRevision: node.revision, resolvedTitle: title, patches: [] };
        }
        return planNodeRename(node, title);
      },
    });

    context.capabilities.provide<ContentCreatePlanRequest, ContentMutationPlan>({
      key: 'content.createPlan@1',
      invoke: (input) => {
        if (!input || typeof input.title !== 'string' ||
          (input.placement !== undefined && input.placement !== 'canvas' && input.placement !== 'system')) {
          throw new Error('content.createPlan request is invalid');
        }
        const created = buildCreateTransaction({
          title: input.title,
          body: input.body,
          x: input.x,
          y: input.y,
          automaticContext: input.automaticContext,
          placement: input.placement,
        }, input.reservedTitles);
        const nodePatch = created.transaction.patches.find((patch) => patch.namespace === NODE_NAMESPACE);
        const contentPatch = created.transaction.patches.find((patch) => patch.namespace === CONTENT_NAMESPACE);
        const content = contentPatch?.value as TextContentRecord | undefined;
        return {
          nodeId: created.nodeId,
          revision: content?.revision ?? 1,
          length: content?.length ?? 0,
          resolvedTitle: created.resolvedTitle,
          geometry: nodePatch?.value && isRecord(nodePatch.value)
            ? {
                x: Number(nodePatch.value.x),
                y: Number(nodePatch.value.y),
                width: Number(nodePatch.value.width),
                height: Number(nodePatch.value.height),
              }
            : undefined,
          patches: created.transaction.patches.map((patch) => ({ ...patch, schemaOwner: 'text-node' })),
          events: created.transaction.events,
        };
      },
    });

    context.capabilities.provide<ContentPlacementPlanRequest, ContentMutationPlan>({
      key: 'content.placementPlan@1',
      invoke: (input) => {
        if (!input || typeof input.nodeId !== 'string' ||
          (input.placement !== 'canvas' && input.placement !== 'system')) {
          throw new Error('content.placementPlan request is invalid');
        }
        const node = context.store.readValue<TextNodeRecord>(NODE_NAMESPACE, input.nodeId);
        if (!node) throw new Error(`Text node not found: ${input.nodeId}`);
        const current = isCanvasTextNode(node) ? 'canvas' : 'system';
        if (current === input.placement) {
          const content = context.store.readValue<TextContentRecord>(CONTENT_NAMESPACE, node.contentId);
          return {
            nodeId: node.id,
            revision: content?.revision ?? 0,
            length: content?.length ?? 0,
            patches: [],
          };
        }
        const content = context.store.readValue<TextContentRecord>(CONTENT_NAMESPACE, node.contentId);
        const next: TextNodeRecord = {
          ...node,
          ...(input.placement === 'system' ? { placement: 'system' } : { placement: undefined }),
          revision: node.revision + 1,
          updatedAt: Date.now(),
        };
        return {
          nodeId: node.id,
          revision: content?.revision ?? 0,
          length: content?.length ?? 0,
          patches: [{
            op: 'set',
            domain: 'document',
            namespace: NODE_NAMESPACE,
            key: node.id,
            value: next,
            schemaOwner: 'text-node',
          }],
          events: [{ type: 'node.placement.changed', payload: { id: node.id, placement: input.placement } }],
        };
      },
    });

    context.capabilities.provide<ContentClonePlanRequest, ContentMutationPlan>({
      key: 'content.clonePlan@1',
      invoke: async (input, signal) => {
        if (!input || typeof input.sourceId !== 'string' || typeof input.title !== 'string' ||
          !Number.isInteger(input.expectedRevision) ||
          (input.x !== undefined && !Number.isFinite(input.x)) ||
          (input.y !== undefined && !Number.isFinite(input.y))) {
          throw new Error('content.clonePlan request is invalid');
        }
        const sourceNode = context.store.readValue<TextNodeRecord>(NODE_NAMESPACE, input.sourceId);
        if (!sourceNode) throw new Error(`Text node not found: ${input.sourceId}`);
        const sourceContent = context.store.readValue<TextContentRecord>(CONTENT_NAMESPACE, sourceNode.contentId);
        if (!sourceContent) throw new Error(`Content not found: ${sourceNode.contentId}`);
        if (sourceContent.revision !== input.expectedRevision) {
          throw new Error(`节点“${sourceNode.title}”正文版本已变化，无法保存旧副本`);
        }

        const count = context.store.count(NODE_NAMESPACE);
        const nodeId = createId('node');
        const contentId = createId('content');
        const now = Date.now();
        const chunkIds: string[] = [];
        const chunkLengths: number[] = [];
        const chunkPatches: PatchOperation[] = [];
        const lengths = contentChunkLengths(sourceContent);
        for (let index = 0; index < lengths.length; index += 1) {
          assertNotAborted(signal);
          const text = readContentChunk(context, sourceContent, index);
          const id = createId('content-chunk');
          chunkIds.push(id);
          chunkLengths.push(text.length);
          chunkPatches.push({
            op: 'set',
            domain: 'document',
            namespace: CONTENT_CHUNK_NAMESPACE,
            key: id,
            value: { id, contentId, text } satisfies TextContentChunkRecord,
            schemaOwner: 'text-node',
          });
          if (index > 0 && index % 8 === 0) await yieldToMainThread();
        }
        if (chunkIds.length === 0) {
          const id = createId('content-chunk');
          chunkIds.push(id);
          chunkLengths.push(0);
          chunkPatches.push({
            op: 'set', domain: 'document', namespace: CONTENT_CHUNK_NAMESPACE, key: id,
            value: { id, contentId, text: '' } satisfies TextContentChunkRecord,
            schemaOwner: 'text-node',
          });
        }
        const content: TextContentRecord = {
          id: contentId,
          storageVersion: 2,
          chunkIds,
          chunkLengths,
          length: sourceContent.length,
          revision: 1,
        };
        const sourceFormat = readFormatRecord(context, sourceNode.id);
        const copiedMarks = readFormatMarks(context, sourceFormat).map((mark) => ({
          ...mark,
          id: createId('format-mark'),
          nodeId,
          revision: 1,
        }));
        const resolvedTitle = titleAllocator([]).allocate(
          input.title.trim().slice(0, 120) || '对话存档',
        );
        const node: TextNodeRecord = {
          ...sourceNode,
          id: nodeId,
          contentId,
          title: resolvedTitle,
          placement: undefined,
          automaticContext: undefined,
          x: input.x ?? 160 + (count % 5) * 320,
          y: input.y ?? 130 + Math.floor(count / 5) * 240,
          revision: 1,
          createdAt: now,
          updatedAt: now,
        };
        return {
          nodeId,
          revision: 1,
          length: content.length,
          resolvedTitle,
          geometry: { x: node.x, y: node.y, width: node.width, height: nodeHeight(node) },
          patches: [
            {
              op: 'set', domain: 'document', namespace: NODE_NAMESPACE, key: nodeId,
              value: node, schemaOwner: 'text-node',
            },
            {
              op: 'set', domain: 'document', namespace: CONTENT_NAMESPACE, key: contentId,
              value: content, schemaOwner: 'text-node',
            },
            ...chunkPatches,
            {
              op: 'set', domain: 'document', namespace: FORMAT_NAMESPACE, key: nodeId,
              value: {
                nodeId,
                storageVersion: 2,
                markIds: copiedMarks.map((mark) => mark.id),
                revision: 1,
                format: { ...sourceFormat.format },
              } satisfies TextFormatRecord,
              schemaOwner: 'text-node',
            },
            ...copiedMarks.map((mark) => ({
              op: 'set' as const,
              domain: 'document' as const,
              namespace: FORMAT_MARK_NAMESPACE,
              key: mark.id,
              value: mark,
              schemaOwner: 'text-node' as const,
            })),
          ],
          events: [{ type: 'node.created', payload: { id: nodeId } }],
        };
      },
    });

    context.capabilities.provide<ContentAppendPlanRequest, ContentMutationPlan>({
      key: 'content.appendPlan@1',
      invoke: async (input) => {
        if (!input || typeof input.nodeId !== 'string' || typeof input.text !== 'string' ||
          !Number.isInteger(input.expectedRevision) || input.text.length > MAX_DOCUMENT_LENGTH) {
          throw new Error('content.appendPlan request is invalid');
        }
        const node = context.store.readValue<TextNodeRecord>(NODE_NAMESPACE, input.nodeId);
        if (!node) throw new Error(`Text node not found: ${input.nodeId}`);
        const content = context.store.readValue<TextContentRecord>(CONTENT_NAMESPACE, node.contentId);
        if (!content) throw new Error(`Content not found: ${node.contentId}`);
        if (content.revision !== input.expectedRevision) {
          throw new Error(`节点“${node.title}”正文版本已变化，无法追加旧内容`);
        }
        if (content.length + input.text.length > MAX_DOCUMENT_LENGTH) {
          throw new Error('单个正文当前最多支持 3200 万 UTF-16 字符');
        }
        const mutation = planContentDelta(context, content, content.length, 0, input.text);
        const formatMutation = planFormattingEdits(context, node.id, [{
          start: content.length,
          deleteCount: 0,
          insertLength: input.text.length,
        }]);
        const anchorPlans = await planExternalAnchors({
          nodeId: node.id,
          start: content.length,
          deleteCount: 0,
          insertLength: input.text.length,
        });
        const nextContent = mutation.content;
        const nextNode = { ...node, revision: node.revision + 1, updatedAt: Date.now() };
        return {
          nodeId: node.id,
          revision: nextContent.revision,
          length: nextContent.length,
          patches: [
            ...mutation.chunkPatches.map((patch) => ({ ...patch, schemaOwner: 'text-node' })),
            {
              op: 'set',
              domain: 'document',
              namespace: CONTENT_NAMESPACE,
              key: content.id,
              value: nextContent,
              schemaOwner: 'text-node',
            },
            {
              op: 'set',
              domain: 'document',
              namespace: NODE_NAMESPACE,
              key: node.id,
              value: nextNode,
              schemaOwner: 'text-node',
            },
            ...formatMutation.patches.map((patch) => ({ ...patch, schemaOwner: 'text-node' as const })),
            ...anchorPlans.flatMap((plan) => plan.patches),
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
          ],
        };
      },
    });

    context.capabilities.provide<ContentDeltaPlanRequest, ContentMutationPlan>({
      key: 'content.deltaPlan@1',
      invoke: async (input) => {
        if (!input || typeof input.nodeId !== 'string' || typeof input.insert !== 'string' ||
          !Number.isInteger(input.start) || !Number.isInteger(input.deleteCount) ||
          !Number.isInteger(input.expectedRevision)) {
          throw new Error('content.deltaPlan request is invalid');
        }
        const node = context.store.readValue<TextNodeRecord>(NODE_NAMESPACE, input.nodeId);
        if (!node) throw new Error(`Text node not found: ${input.nodeId}`);
        const content = context.store.readValue<TextContentRecord>(CONTENT_NAMESPACE, node.contentId);
        if (!content) throw new Error(`Content not found: ${node.contentId}`);
        if (content.revision !== input.expectedRevision) {
          throw new Error(`节点“${node.title}”正文版本已变化，无法应用旧提案`);
        }
        if (input.start < 0 || input.deleteCount < 0 || input.start + input.deleteCount > content.length) {
          throw new Error('AI 提案写入范围已经超出正文');
        }
        if (content.length - input.deleteCount + input.insert.length > MAX_DOCUMENT_LENGTH) {
          throw new Error('AI 提案写入后超过单节点 3200 万字符上限');
        }
        const mutation = planContentDelta(context, content, input.start, input.deleteCount, input.insert);
        const formatMutation = planFormattingEdits(context, node.id, [{
          start: input.start,
          deleteCount: input.deleteCount,
          insertLength: input.insert.length,
        }]);
        const anchorPlans = await planExternalAnchors({
          nodeId: node.id,
          start: input.start,
          deleteCount: input.deleteCount,
          insertLength: input.insert.length,
        });
        const nextNode = { ...node, revision: node.revision + 1, updatedAt: Date.now() };
        return {
          nodeId: node.id,
          revision: mutation.content.revision,
          length: mutation.content.length,
          patches: [
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
              key: node.id,
              value: nextNode,
              schemaOwner: 'text-node',
            },
            ...formatMutation.patches.map((patch) => ({ ...patch, schemaOwner: 'text-node' as const })),
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
        };
      },
    });

    context.capabilities.provide<undefined, AIContextCatalogContribution>({
      key: 'context.catalog@1',
      invoke: () => ({
        provider: 'text-node',
        sources: Object.values(readNodes()).filter(isCanvasTextNode).flatMap((node) => {
          const content = context.store.readValue<TextContentRecord>(CONTENT_NAMESPACE, node.contentId);
          return content ? [toContextSource(node, content)] : [];
        }),
      }),
    });

    context.capabilities.provide<AIContextReadRequest, AIContextReadContribution>({
      key: 'context.read@1',
      invoke: (input) => {
        if (!input || typeof input.sourceId !== 'string') return { handled: false };
        const node = context.store.readValue<TextNodeRecord>(NODE_NAMESPACE, input.sourceId);
        if (!node) return { handled: false };
        const content = context.store.readValue<TextContentRecord>(CONTENT_NAMESPACE, node.contentId);
        if (!content) return { handled: true };
        const source = toContextSource(node, content);
        const start = Math.max(0, Math.min(content.length, Number.isFinite(input.start) ? input.start : 0));
        const length = Math.max(0, Math.min(64 * 1024, Number.isFinite(input.length) ? input.length : 4096));
        return { handled: true, source, start, text: readContentRange(context, content, start, length) };
      },
    });

    context.capabilities.provide<AIContextSearchRequest, AIContextSearchContribution>({
      key: 'context.search@1',
      invoke: async (input, signal) => searchContextNodes(
        Object.fromEntries(Object.entries(readNodes()).filter(([, node]) => isCanvasTextNode(node))),
        (node) => context.store.readValue<TextContentRecord>(CONTENT_NAMESPACE, node.contentId),
        (content, index) => readContentChunk(context, content, index),
        input,
        signal,
      ),
    });

    context.capabilities.provide<{ nodeId: string }, TextFormatSnapshot>({
      key: 'content.formatting@1',
      invoke: (input) => {
        if (!input || typeof input.nodeId !== 'string') {
          throw new Error('content.formatting requires nodeId');
        }
        const node = context.store.readValue<TextNodeRecord>(NODE_NAMESPACE, input.nodeId);
        if (!node) throw new Error(`Text node not found: ${input.nodeId}`);
        return toFormatSnapshot(readFormatRecord(context, node.id));
      },
    });

    context.capabilities.provide<TextFormattingRequest, TextFormattingSnapshot>({
      key: 'content.formatting@2',
      invoke: (input) => {
        if (!input || typeof input.nodeId !== 'string') {
          throw new Error('content.formatting requires nodeId');
        }
        const node = context.store.readValue<TextNodeRecord>(NODE_NAMESPACE, input.nodeId);
        if (!node) throw new Error(`Text node not found: ${input.nodeId}`);
        const content = context.store.readValue<TextContentRecord>(CONTENT_NAMESPACE, node.contentId);
        if (!content) throw new Error(`Content not found: ${node.contentId}`);
        const start = Number.isInteger(input.start)
          ? Math.max(0, Math.min(content.length, input.start!))
          : 0;
        const requestedLength = Number.isInteger(input.length) ? Math.max(0, input.length!) : content.length;
        const length = Math.min(requestedLength, content.length - start);
        return toFormattingSnapshot(context, readFormatRecord(context, node.id), content, start, length);
      },
    });

    context.capabilities.provide<AppearanceReadRequest, AppearanceReadContribution>({
      key: 'appearance.read@1',
      invoke: (input) => {
        const selectedIds = [...new Set(Array.isArray(input?.selectedIds) ? input.selectedIds : [])];
        const selectedNodes = selectedIds
          .map((id) => context.store.readValue<TextNodeRecord>(NODE_NAMESPACE, id))
          .filter((node): node is TextNodeRecord => Boolean(node));
        const targets: AppearanceReadContribution['targets'] = [];
        if (selectedNodes.length > 0) {
          const colors = selectedNodes.map((node) => node.titleColor);
          targets.push({
            kind: 'node-title',
            label: selectedNodes.every((node) => node.presentation === 'text-box') ? '文本框' : '节点标题栏',
            scopeLabel: `${selectedNodes.length} 个选中文字对象`,
            color: colors[0],
            mixed: new Set(colors).size > 1,
            entities: selectedNodes.map((node) => ({
              id: node.id,
              revision: node.revision,
              expectedColor: node.titleColor,
            })),
          });
        }
        const activeNode = input?.activeNodeId
          ? context.store.readValue<TextNodeRecord>(NODE_NAMESPACE, input.activeNodeId)
          : undefined;
        const textNodes = activeNode ? [activeNode] : selectedNodes;
        if (input?.mode !== 'selection' && textNodes.length > 0) {
          const formats = textNodes.map((node) => readFormatRecord(context, node.id));
          const colors = formats.map((format) => format.format.color);
          targets.push({
            kind: 'text-color',
            label: '正文文字',
            scopeLabel: activeNode ? `活动编辑器：${activeNode.title}` : `${textNodes.length} 个文本节点`,
            color: colors[0],
            mixed: new Set(colors).size > 1,
            entities: formats.map((format) => ({
              id: format.nodeId,
              revision: format.revision,
              expectedColor: format.format.color,
            })),
          });
        }
        return { targets };
      },
    });

    context.capabilities.provide<AppearanceUpdateRequest, AppearanceUpdatePlan>({
      key: 'appearance.updatePlan@1',
      invoke: (input) => {
        if (input.kind !== 'node-title' && input.kind !== 'text-color') {
          return { patches: [], changed: 0 };
        }
        validateAppearanceUpdate(input);
        return input.kind === 'node-title'
          ? buildTitleColorPlan(context, input.color, input.entities)
          : buildTextColorPlan(context, input.color, input.entities);
      },
    });

    context.capabilities.provide<undefined, AppearanceColorContribution>({
      key: 'appearance.colors@1',
      invoke: () => {
        const counts = new Map<string, number>();
        const add = (color: string | undefined) => {
          if (!color) return;
          const normalized = color.toLowerCase();
          counts.set(normalized, (counts.get(normalized) ?? 0) + 1);
        };
        for (const node of Object.values(readNodes()).filter(isCanvasTextNode)) {
          add(node.titleColor);
          const format = readFormatRecord(context, node.id);
          add(format.format.color);
          for (const mark of readFormatMarks(context, format)) add(mark.format.color);
        }
        return { colors: [...counts].map(([color, count]) => ({ color, count })) };
      },
    });

    context.capabilities.provide<undefined, AppearanceUpdatePlan>({
      key: 'appearance.resetPlan@1',
      invoke: () => {
        const patches: PatchOperation[] = [];
        const titleIds: string[] = [];
        const formatIds: string[] = [];
        const updatedAt = Date.now();
        const canvasNodes = Object.values(readNodes()).filter(isCanvasTextNode);
        for (const [index, node] of canvasNodes.entries()) {
          const defaultTitleColor = defaultNodeTitleColor(index);
          if (node.titleColor !== defaultTitleColor) {
            titleIds.push(node.id);
            patches.push({
              op: 'set',
              domain: 'document',
              namespace: NODE_NAMESPACE,
              key: node.id,
              value: {
                ...node,
                titleColor: defaultTitleColor,
                revision: node.revision + 1,
                updatedAt,
              },
              schemaOwner: 'text-node',
            });
          }

          const storedFormat = context.store.readValue<TextFormatRecord>(FORMAT_NAMESPACE, node.id);
          if (!storedFormat) continue;
          const format = readFormatRecord(context, node.id);
          const marks = readFormatMarks(context, format);
          const coloredMarks = marks.filter((mark) => mark.format.color !== undefined);
          if (format.format.color === DEFAULT_TEXT_DOCUMENT_FORMAT.color && coloredMarks.length === 0) continue;
          formatIds.push(node.id);
          const removedMarkIds = new Set<string>();
          for (const mark of coloredMarks) {
            const nextFormat = { ...mark.format };
            delete nextFormat.color;
            if (Object.keys(nextFormat).length === 0) {
              removedMarkIds.add(mark.id);
              patches.push({
                op: 'delete',
                domain: 'document',
                namespace: FORMAT_MARK_NAMESPACE,
                key: mark.id,
                schemaOwner: 'text-node',
              });
            } else {
              patches.push({
                op: 'set',
                domain: 'document',
                namespace: FORMAT_MARK_NAMESPACE,
                key: mark.id,
                value: { ...mark, format: nextFormat, revision: mark.revision + 1 },
                schemaOwner: 'text-node',
              });
            }
          }
          patches.push({
            op: 'set',
            domain: 'document',
            namespace: FORMAT_NAMESPACE,
            key: node.id,
            value: {
              ...format,
              markIds: (format.markIds ?? []).filter((id) => !removedMarkIds.has(id)),
              revision: format.revision + 1,
              format: { ...format.format, color: DEFAULT_TEXT_DOCUMENT_FORMAT.color },
            },
            schemaOwner: 'text-node',
          });
        }
        return {
          patches,
          changed: titleIds.length + formatIds.length,
          events: [
            ...(titleIds.length > 0
              ? [{ type: 'node.appearance.changed', payload: { ids: titleIds, kind: 'node-title' } }]
              : []),
            ...(formatIds.length > 0
              ? [{ type: 'content.format.changed', payload: { nodeIds: formatIds } }]
              : []),
          ],
        };
      },
    });

    context.capabilities.provide<{ ids: string[] }, EntityDeletePlan>({
      key: 'entity.deletePlan@1',
      invoke: (input) => {
        const ids = Array.isArray(input?.ids) ? [...new Set(input.ids)] : [];
        const patches: EntityDeletePlan['patches'] = [];
        const deleted: string[] = [];
        for (const id of ids) {
          const node = context.store.readValue<TextNodeRecord>(NODE_NAMESPACE, id);
          if (!node) continue;
          const content = context.store.readValue<TextContentRecord>(CONTENT_NAMESPACE, node.contentId);
          deleted.push(id);
          patches.push(
            {
              op: 'delete',
              domain: 'document',
              namespace: NODE_NAMESPACE,
              key: node.id,
              schemaOwner: 'text-node',
            },
            {
              op: 'delete',
              domain: 'document',
              namespace: CONTENT_NAMESPACE,
              key: node.contentId,
              schemaOwner: 'text-node',
            },
          );
          if (content) {
            for (const chunkId of contentChunkIds(content)) {
              patches.push({
                op: 'delete',
                domain: 'document',
                namespace: CONTENT_CHUNK_NAMESPACE,
                key: chunkId,
                schemaOwner: 'text-node',
              });
            }
          }
          if (context.store.readValue<TextFormatRecord>(FORMAT_NAMESPACE, node.id)) {
            const format = readFormatRecord(context, node.id);
            for (const mark of readFormatMarks(context, format)) {
              patches.push({
                op: 'delete',
                domain: 'document',
                namespace: FORMAT_MARK_NAMESPACE,
                key: mark.id,
                schemaOwner: 'text-node',
              });
            }
            patches.push({
              op: 'delete',
              domain: 'document',
              namespace: FORMAT_NAMESPACE,
              key: node.id,
              schemaOwner: 'text-node',
            });
          }
        }
        return {
          patches,
          events: deleted.length > 0 ? [{ type: 'nodes.deleted', payload: { ids: deleted } }] : [],
        };
      },
    });

    context.capabilities.provide<{ ids: string[] }, ClipboardFragment>({
      key: 'clipboard.serialize@1',
      invoke: (input) => {
        const selected = new Set(Array.isArray(input?.ids) ? input.ids : []);
        const nodes = Object.values(readNodes())
          .filter((node) => selected.has(node.id))
          .map((node) => ({
            node,
            storedContent: context.store.readValue<TextContentRecord>(CONTENT_NAMESPACE, node.contentId),
            format: context.store.readValue<TextFormatRecord>(FORMAT_NAMESPACE, node.id),
          }))
          .filter(
            (entry): entry is {
              node: TextNodeRecord;
              storedContent: TextContentRecord;
              format: TextFormatRecord | undefined;
            } => Boolean(entry.storedContent),
          )
          .map(({ node, storedContent, format }) => ({
            node,
            content: {
              id: storedContent.id,
              chunks: readAllContentChunks(context, storedContent),
              length: storedContent.length,
              revision: storedContent.revision,
            },
            format,
            marks: format ? readFormatMarks(context, format) : [],
          }));
        const plainTextPreview = nodes
          .slice(0, 8)
          .map(({ node, content }) => `${node.title}\n${readRange(content.chunks, 0, 320)}`)
          .join('\n\n')
          .slice(0, 4096);
        return {
          owner: 'text-node',
          version: 1,
          entityIds: nodes.map(({ node }) => node.id),
          payload: { nodes, plainTextPreview } satisfies SerializedTextNodes,
        };
      },
    });

    context.capabilities.provide<ClipboardInstantiateInput, ClipboardInstantiatePlan>({
      key: 'clipboard.instantiate@1',
      invoke: (input) => {
        const fragment = input.fragments.find((item) => item.owner === 'text-node' && item.version === 1);
        if (!fragment || !isSerializedTextNodes(fragment.payload)) return { patches: [] };
        const patches: ClipboardInstantiatePlan['patches'] = [];
        const createdIds: string[] = [];
        const existingNodes = readNodeIndex().nodes;
        const clipboardTitles = createNodeTitleAllocator(existingNodes.map((node) => node.title));
        for (const { node, content, format, marks = [] } of fragment.payload.nodes) {
          const nodeId = input.idMap[node.id];
          if (!nodeId) continue;
          const contentId = createId('content');
          const createdContent = createContentStorageFromChunks(contentId, content.chunks, 1);
          const now = Date.now();
          const copiedMarks = marks.map((mark) => ({
            ...mark,
            id: createId('format-mark'),
            nodeId,
            revision: 1,
          }));
          const title = clipboardTitles.allocate(node.title);
          createdIds.push(nodeId);
          patches.push(
            {
              op: 'set',
              domain: 'document',
              namespace: NODE_NAMESPACE,
              key: nodeId,
              value: {
                ...node,
                id: nodeId,
                contentId,
                title,
                x: node.x + input.offset.x,
                y: node.y + input.offset.y,
                revision: 1,
                createdAt: now,
                updatedAt: now,
              },
              schemaOwner: 'text-node',
            },
            {
              op: 'set',
              domain: 'document',
              namespace: CONTENT_NAMESPACE,
              key: contentId,
              value: createdContent.content,
              schemaOwner: 'text-node',
            },
            ...createdContent.chunkPatches.map((patch) => ({ ...patch, schemaOwner: 'text-node' as const })),
            {
              op: 'set',
              domain: 'document',
              namespace: FORMAT_NAMESPACE,
              key: nodeId,
              value: {
                nodeId,
                storageVersion: 2,
                markIds: copiedMarks.map((mark) => mark.id),
                revision: 1,
                format: validateDocumentFormat({
                  ...DEFAULT_TEXT_DOCUMENT_FORMAT,
                  ...(format?.format ?? {}),
                }),
              },
              schemaOwner: 'text-node',
            },
            ...copiedMarks.map((mark) => ({
              op: 'set' as const,
              domain: 'document' as const,
              namespace: FORMAT_MARK_NAMESPACE,
              key: mark.id,
              value: mark,
              schemaOwner: 'text-node' as const,
            })),
          );
        }
        return {
          patches,
          createdIds,
          selectIds: createdIds,
          events: createdIds.length > 0 ? [{ type: 'nodes.pasted', payload: { ids: createdIds } }] : [],
        };
      },
    });

    const runContentSearch = async (
      input: ContentSearchRequest,
      signal: AbortSignal | undefined,
      includeTitles: boolean,
    ): Promise<ContentSearchResult | ContentSearchResultV2> => {
        validateSearchRequest(input);
        const allowed = input.nodeIds ? new Set(input.nodeIds) : undefined;
        const nodes = Object.values(readNodes())
          .filter(isCanvasTextNode)
          .filter((node) => !allowed || allowed.has(node.id));
        const hits: Array<SearchHit | SearchHitV2> = [];
        let scannedNodes = 0;
        let truncated = false;
        for (const node of nodes) {
          assertNotAborted(signal);
          const content = context.store.readValue<TextContentRecord>(CONTENT_NAMESPACE, node.contentId);
          if (!content) continue;
          if (includeTitles) {
            const titleResult = searchNodeTitle(node, input, input.maxResults - hits.length);
            hits.push(...titleResult.hits);
            if (titleResult.truncated || hits.length >= input.maxResults) {
              truncated = true;
              scannedNodes += 1;
              break;
            }
          }
          const remaining = input.maxResults - hits.length;
          const result = await searchChunks(
            node,
            content,
            (index) => readContentChunk(context, content, index),
            input,
            remaining,
            signal,
          );
          hits.push(...(includeTitles
            ? result.hits.map((hit) => ({ ...hit, field: 'body' as const }))
            : result.hits));
          scannedNodes += 1;
          if (result.truncated || hits.length >= input.maxResults) {
            truncated = true;
            break;
          }
        }
        return { hits, scannedNodes, truncated };
    };

    context.capabilities.provide<ContentSearchRequest, ContentSearchResult>({
      key: 'content.search@1',
      invoke: (input, signal) => runContentSearch(input, signal, false) as Promise<ContentSearchResult>,
    });

    context.capabilities.provide<ContentSearchRequest, ContentSearchResultV2>({
      key: 'content.search@2',
      invoke: (input, signal) => runContentSearch(input, signal, true) as Promise<ContentSearchResultV2>,
    });

    const createReplacePlan = async (
      input: ContentReplaceRequest,
      includeTitles: boolean,
    ): Promise<ContentReplacePlan> => {
      if (!input || !Array.isArray(input.hits) || typeof input.replacement !== 'string') {
        throw new Error('替换请求格式不正确');
      }
      const nodes = readNodeIndex().nodes.filter(isCanvasTextNode);
      const nodeById = new Map(nodes.map((node) => [node.id, node]));
      const titleHitsByNode = new Map<string, SearchHit[]>();
      const bodyHitsByNode = new Map<string, SearchHit[]>();
      for (const hit of input.hits) {
        const field = hit.field ?? 'body';
        if (field === 'title' && !includeTitles) {
          throw new Error('标题命中只用于定位，请选择正文命中进行替换');
        }
        const grouped = field === 'title' ? titleHitsByNode : bodyHitsByNode;
        const list = grouped.get(hit.nodeId) ?? [];
        list.push(hit);
        grouped.set(hit.nodeId, list);
      }

      const finalTitles = new Map<string, string>();
      for (const [nodeId, rawHits] of titleHitsByNode) {
        const node = nodeById.get(nodeId);
        if (!node) throw new Error(`搜索结果对应的节点已不存在：${nodeId}`);
        const hits = [...rawHits].sort((left, right) => left.start - right.start);
        let previousEnd = -1;
        for (const hit of hits) {
          if (hit.title !== node.title) throw new Error(`节点“${node.title}”标题已修改，请重新查找`);
          if (hit.start < previousEnd) throw new Error('标题替换范围发生重叠');
          if (node.title.slice(hit.start, hit.start + hit.length) !== hit.matchedText) {
            throw new Error(`节点“${node.title}”的标题匹配已变化，请重新查找`);
          }
          previousEnd = hit.start + hit.length;
        }
        let title = node.title;
        for (const hit of [...hits].sort((left, right) => right.start - left.start)) {
          title = `${title.slice(0, hit.start)}${input.replacement}${title.slice(hit.start + hit.length)}`;
        }
        finalTitles.set(nodeId, normalizeNodeTitle(title));
      }

      const titleOwners = new Map<string, string>();
      for (const node of nodes) {
        const title = finalTitles.get(node.id) ?? node.title;
        const key = nodeTitleKey(title);
        const occupiedBy = titleOwners.get(key);
        if (occupiedBy && occupiedBy !== node.id) {
          throw new Error(`替换后的标题“${title}”已经存在，请调整替换内容`);
        }
        titleOwners.set(key, node.id);
      }

      type ReplacementEdit = ContentSubstitution & {
        matchedText: string;
        source: 'search' | 'title-reference';
      };
      const contentEdits = new Map<string, ReplacementEdit[]>();
      for (const [nodeId, rawHits] of bodyHitsByNode) {
        const node = nodeById.get(nodeId);
        if (!node) throw new Error(`搜索结果对应的节点已不存在：${nodeId}`);
        const content = context.store.readValue<TextContentRecord>(CONTENT_NAMESPACE, node.contentId);
        if (!content) throw new Error(`搜索结果对应的正文已不存在：${nodeId}`);
        const hits = [...rawHits].sort((left, right) => left.start - right.start);
        let previousEnd = -1;
        for (const hit of hits) {
          if (hit.revision !== content.revision) throw new Error(`节点“${node.title}”正文已修改，请重新查找`);
          if (hit.start < previousEnd) throw new Error('正文替换范围发生重叠');
          if (readContentRange(context, content, hit.start, hit.length) !== hit.matchedText) {
            throw new Error(`节点“${node.title}”的正文匹配已变化，请重新查找`);
          }
          previousEnd = hit.start + hit.length;
        }
        contentEdits.set(nodeId, hits.map((hit) => ({
          start: hit.start,
          length: hit.length,
          replacement: input.replacement,
          matchedText: hit.matchedText,
          source: 'search',
        })));
      }

      const catalogTitles = nodes.map((node) => node.title.trim()).filter(isReferenceTitle);
      let referenceReplacementCount = 0;
      for (const [targetNodeId, finalTitle] of finalTitles) {
        const targetNode = nodeById.get(targetNodeId)!;
        if (finalTitle === targetNode.title || !isReferenceTitle(targetNode.title)) continue;
        for (const referencingNode of nodes) {
          if (referencingNode.id === targetNodeId) continue;
          const content = context.store.readValue<TextContentRecord>(CONTENT_NAMESPACE, referencingNode.contentId);
          if (!content) continue;
          const remaining = MAX_TITLE_REFERENCE_REPLACEMENTS - referenceReplacementCount;
          const found = await findLinkedTitleHits({
            node: referencingNode,
            content,
            targetNodeId,
            targetTitle: targetNode.title,
            catalogTitles,
            readChunk: (index) => readContentChunk(context, content, index),
            limit: remaining + 1,
          });
          if (found.hits.length > remaining) {
            throw new Error(`标题替换需要同步的正文关联超过 ${MAX_TITLE_REFERENCE_REPLACEMENTS} 处，请缩小替换范围`);
          }
          if (found.hits.length === 0) continue;
          referenceReplacementCount += found.hits.length;
          const edits = contentEdits.get(referencingNode.id) ?? [];
          for (const hit of found.hits) {
            const overlapsDirectHit = edits.some((edit) => edit.source === 'search' &&
              rangesOverlap(edit.start, edit.length, hit.start, hit.length));
            if (overlapsDirectHit) continue;
            const duplicate = edits.some((edit) => edit.source === 'title-reference' &&
              edit.start === hit.start && edit.length === hit.length && edit.replacement === finalTitle);
            if (duplicate) continue;
            if (edits.some((edit) => rangesOverlap(edit.start, edit.length, hit.start, hit.length))) {
              throw new Error('标题关联替换范围发生重叠，请缩小替换范围');
            }
            edits.push({
              start: hit.start,
              length: hit.length,
              replacement: finalTitle,
              matchedText: hit.matchedText,
              source: 'title-reference',
            });
          }
          if (edits.length > 0) contentEdits.set(referencingNode.id, edits);
        }
      }

      const patches: ContentReplacePlan['patches'] = [];
      const events: NonNullable<ContentReplacePlan['events']> = [];
      const contentMutations = new Map<string, {
        content: TextContentRecord;
        chunkPatches: PatchOperation[];
        formatPatches: PatchOperation[];
        formatRevision?: number;
      }>();
      for (const [nodeId, edits] of contentEdits) {
        if (edits.length === 0) continue;
        const node = nodeById.get(nodeId)!;
        const content = context.store.readValue<TextContentRecord>(CONTENT_NAMESPACE, node.contentId)!;
        const sorted = [...edits].sort((left, right) => left.start - right.start);
        let previousEnd = -1;
        for (const edit of sorted) {
          if (edit.start < previousEnd) throw new Error('替换范围发生重叠');
          previousEnd = edit.start + edit.length;
        }
        const mutation = planContentSubstitutions(context, content, sorted);
        const formatMutation = planFormattingEdits(
          context,
          node.id,
          [...sorted].sort((left, right) => right.start - left.start).map((edit) => ({
            start: edit.start,
            deleteCount: edit.length,
            insertLength: edit.replacement.length,
          })),
        );
        contentMutations.set(nodeId, {
          content: mutation.content,
          chunkPatches: mutation.chunkPatches,
          formatPatches: formatMutation.patches,
          formatRevision: formatMutation.revision,
        });
      }

      const updatedAt = Date.now();
      const touchedNodeIds = new Set([...finalTitles.keys(), ...contentMutations.keys()]);
      for (const nodeId of touchedNodeIds) {
        const node = nodeById.get(nodeId)!;
        const finalTitle = finalTitles.get(nodeId) ?? node.title;
        const contentMutation = contentMutations.get(nodeId);
        const titleChanged = finalTitle !== node.title;
        if (!titleChanged && !contentMutation) continue;
        if (contentMutation) {
          patches.push(
            ...contentMutation.chunkPatches.map((patch) => ({ ...patch, schemaOwner: 'text-node' as const })),
            {
              op: 'set',
              domain: 'document',
              namespace: CONTENT_NAMESPACE,
              key: node.contentId,
              value: contentMutation.content,
              schemaOwner: 'text-node',
            },
            ...contentMutation.formatPatches.map((patch) => ({ ...patch, schemaOwner: 'text-node' as const })),
          );
        }
        patches.push({
          op: 'set',
          domain: 'document',
          namespace: NODE_NAMESPACE,
          key: node.id,
          value: { ...node, title: finalTitle, revision: node.revision + 1, updatedAt },
          schemaOwner: 'text-node',
        });
        if (titleChanged) events.push({ type: 'node.renamed', payload: { id: node.id } });
        if (contentMutation) {
          events.push({
            type: 'content.changed',
            payload: {
              nodeId,
              revision: contentMutation.content.revision,
              length: contentMutation.content.length,
            },
          });
          if (contentMutation.formatRevision !== undefined) events.push({
            type: 'content.format.changed',
            payload: { nodeId, revision: contentMutation.formatRevision },
          });
        }
      }
      return {
        patches,
        events,
        replaced: input.hits.length,
        affectedNodes: new Set(input.hits.map((hit) => hit.nodeId)).size,
      };
    };

    context.capabilities.provide<ContentReplaceRequest, ContentReplacePlan>({
      key: 'content.replacePlan@1',
      invoke: (input) => createReplacePlan(input, false),
    });

    context.capabilities.provide<ContentReplaceRequest, ContentReplacePlan>({
      key: 'content.replacePlan@2',
      invoke: (input) => createReplacePlan(input, true),
    });

    context.capabilities.provide<undefined, ContentStatistics>({
      key: 'content.statistics@1',
      invoke: async (_input, signal) => {
        const nodes = Object.values(readNodes()).filter(isCanvasTextNode);
        const result: ContentStatistics = {
          nodeCount: nodes.length,
          utf16Units: 0,
          graphemes: 0,
          nonWhitespaceGraphemes: 0,
          words: 0,
          lines: 0,
          revisions: {},
        };
        for (const node of nodes) {
          assertNotAborted(signal);
          const content = context.store.readValue<TextContentRecord>(CONTENT_NAMESPACE, node.contentId);
          if (!content) continue;
          const signature = contentStatisticsSignature(content);
          let counts = statisticsCache.get(content.id);
          if (!counts || counts.signature !== signature) {
            counts = { signature, ...await countContentChunks(context, content, signal) };
            statisticsCache.set(content.id, counts);
          }
          result.utf16Units += content.length;
          result.graphemes += counts.graphemes;
          result.nonWhitespaceGraphemes += counts.nonWhitespaceGraphemes;
          result.words += counts.words;
          result.lines += counts.lines;
          result.revisions[node.id] = content.revision;
        }
        const liveContentIds = new Set(nodes.map((node) => node.contentId));
        for (const id of statisticsCache.keys()) if (!liveContentIds.has(id)) statisticsCache.delete(id);
        return result;
      },
    });

}
