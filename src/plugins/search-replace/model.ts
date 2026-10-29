import { createId, isRecord, type PluginDefinition, type TaskHandle } from '../../core/contracts.ts';
import type {
  ContentReplacePlan,
  ContentReplaceRequest,
  ContentSearchRequest,
  ContentSearchResultV2,
  SearchMatchPreview,
  SearchQueryPreview,
  SearchNavigationSignal,
  SearchRequest,
  SearchReplaceTargetsRequest,
  SearchResult,
  SearchHit,
  SearchStatus,
} from '../../protocols/search.ts';
import type { SelectionSnapshot } from '../../protocols/selection.ts';
import type { EditorContextSnapshot, EditorSelectionSnapshot } from '../../protocols/editor.ts';
import { normalizeFloatingRect, type FloatingPanelRect } from '../../protocols/floating.ts';
import { isAbortError } from '../../services/abort.ts';
import { defineManifest } from '../manifest.ts';
import { resolveSearchNavigation } from './navigation.ts';

const SEARCH_NAMESPACE = 'searchUI';
const DEFAULT_SEARCH_RECT: FloatingPanelRect = { x: 160, y: 88, width: 500, height: 620 };

interface PendingReplacementNavigation {
  nodeId: string;
  afterStart: number;
  query: string;
}

interface ReplacementNavigationAnchor {
  nodeId: string;
  afterStart: number;
}

interface NavigationScopeState {
  requestId: string;
  nodeIds?: string[];
  selectionAvailable: boolean;
}

export function createSearchReplacePlugin(panel?: unknown): PluginDefinition {
  let activeTask: TaskHandle<SearchResult> | undefined;
  let debounceTask: TaskHandle<void> | undefined;
  let latestRequest: SearchRequest | undefined;
  let latestResult: SearchResult | undefined;
  let navigationState: SearchNavigationSignal | undefined;
  let navigationScope: NavigationScopeState | undefined;
  let expectedNavigationSelections: string[][] = [];
  let pendingNavigation: PendingReplacementNavigation | undefined;
  let highlightedHit: SearchHit | undefined;
  return {
    manifest: defineManifest('search-replace', '查找替换', {
      namespaces: [SEARCH_NAMESPACE],
      namespaceDomains: { [SEARCH_NAMESPACE]: 'workspace' },
      requiresCapabilities: ['content.search@2', 'content.replacePlan@2'],
      optionalCapabilities: [
        'editor.activeNode@1',
        'editor.context@1',
        'editor.selection@1',
        'selection.read@1',
      ],
      providesCapabilities: ['search.state@1'],
      commands: [
        'search.open',
        'search.close',
        'search.focus',
        'search.previous',
        'search.next',
        'search.setPanelRect',
        'search.run',
        'search.replace',
        'search.replaceTargets',
      ],
      dispatches: ['editor.open', 'editor.revealRange', 'selection.set', 'selection.clear'],
      events: [
        'search.replaced',
        'content.changed',
        'node.renamed',
        'document.replaced',
        'editor.panes.changed',
        'editor.active.changed',
        'selection.changed',
      ],
      signals: [
        'search.status',
        'search.results',
        'search.results.clear',
        'search.query.preview',
        'search.selection.preview',
        'search.navigation',
        'search.navigation.reset',
        'search.navigation.clear',
        'search.match.preview',
        'search.editorContext',
        'search.panel.preview',
        'editor.selection.preview',
      ],
      ui: ['search.open-button', 'search.panel'],
      actions: ['search.open-action'],
      shortcuts: [
        'search.open-shortcut',
        'search.close-shortcut',
        'search.previous-shortcut',
        'search.next-shortcut',
      ],
      permissions: [
        'store.own.read',
        'store.own.write',
        'ui.top.contribute',
        'ui.overlay.contribute',
        'ui.action.register',
        'ui.shortcut.register',
        'tasks.schedule',
      ],
    }),

    start(context) {
      activeTask = undefined;
      debounceTask = undefined;
      latestRequest = undefined;
      latestResult = undefined;
      navigationState = undefined;
      navigationScope = undefined;
      expectedNavigationSelections = [];
      pendingNavigation = undefined;
      highlightedHit = undefined;
      const isOpen = () => context.store.readValue<boolean>(SEARCH_NAMESPACE, 'open') ?? false;
      const readRect = () => normalizeFloatingRect(
        context.store.readValue(SEARCH_NAMESPACE, 'panelRect'),
        DEFAULT_SEARCH_RECT,
      );
      const clearNavigation = () => {
        navigationState = undefined;
        navigationScope = undefined;
        expectedNavigationSelections = [];
        highlightedHit = undefined;
        context.signals.emit('search.navigation.clear', {});
        context.signals.emit('search.match.preview', { clear: true } satisfies SearchMatchPreview);
      };
      const revealPendingResult = async (result: SearchResult) => {
        const pending = pendingNavigation;
        if (!pending) return;
        pendingNavigation = undefined;
        if (pending.query !== result.query) return;
        let activeNodeId: string | undefined;
        try {
          activeNodeId = await context.capabilities.request<string | undefined>('editor.activeNode@1');
        } catch {
          return;
        }
        if (activeNodeId !== pending.nodeId) return;
        const hits = result.hits
          .filter((hit) => hit.nodeId === activeNodeId && hit.field === 'body')
          .sort((left, right) => left.start - right.start);
        if (hits.length === 0) {
          context.signals.emit('search.status', {
            requestId: result.requestId,
            state: 'ready',
            message: '当前文本编辑区没有下一处查找结果',
          } satisfies SearchStatus);
          return;
        }
        const forwardIndex = hits.findIndex((hit) => hit.start >= pending.afterStart);
        const index = forwardIndex >= 0 ? forwardIndex : 0;
        const hit = hits[index];
        try {
          await context.commands.dispatch('editor.revealRange', {
            id: activeNodeId,
            start: hit.start,
            end: hit.start + hit.length,
            revision: hit.revision,
          });
        } catch {
          return;
        }
        highlightedHit = hit;
        context.signals.emit('search.match.preview', {
          nodeId: hit.nodeId,
          field: hit.field,
          start: hit.start,
          length: hit.length,
        } satisfies SearchMatchPreview);
        navigationState = {
          nodeId: activeNodeId,
          index,
          total: hits.length,
          scope: 'selection',
          scopeNodeCount: 1,
        } satisfies SearchNavigationSignal;
        context.signals.emit('search.navigation', navigationState);
        context.signals.emit('search.status', {
          requestId: result.requestId,
          state: 'ready',
          message: `已自动跳到当前文本编辑区第 ${index + 1} / ${hits.length} 处`,
        } satisfies SearchStatus);
      };
      const setOpen = (open: boolean) => ({
        transaction: {
          label: open ? '打开查找替换' : '关闭查找替换',
          history: false,
          patches: [
            { op: 'set' as const, domain: 'workspace' as const, namespace: SEARCH_NAMESPACE, key: 'open', value: open },
          ],
        },
      });

      context.commands.register({
        type: 'search.open',
        handle: () => {
          context.ui.activateSurface('overlay.floating', 'search.panel', 'search.close');
          return setOpen(true);
        },
      });
      context.commands.register({
        type: 'search.close',
        handle: () => {
          context.ui.deactivateSurface('overlay.floating', 'search.panel');
          return setOpen(false);
        },
      });
      context.commands.register({
        type: 'search.focus',
        handle: () => {
          if (!isOpen()) return { result: false };
          context.ui.activateSurface('overlay.floating', 'search.panel', 'search.close');
          return { result: true };
        },
      });
      const navigate = async (direction: -1 | 1) => {
        const source = latestResult;
        if (!source) throw new Error('请先完成一次查找');
        if (!navigationScope || navigationScope.requestId !== source.requestId) {
          let selectionAvailable = false;
          let nodeIds: string[] | undefined;
          try {
            const selection = await context.capabilities.request<SelectionSnapshot>('selection.read@1');
            selectionAvailable = true;
            const selectedTextNodes = selection.items
              .filter((item) => item.kind === 'text-node')
              .map((item) => item.id);
            if (selectedTextNodes.length > 0) nodeIds = [...new Set(selectedTextNodes)];
          } catch {
            // A headless composition may omit selection; navigation then covers the full canvas result.
          }
          navigationScope = { requestId: source.requestId, nodeIds, selectionAvailable };
        }
        const scope = navigationScope;
        const target = resolveSearchNavigation(source.hits, scope.nodeIds, navigationState, direction);
        if (!target) {
          throw new Error(scope.nodeIds?.length
            ? '选中的文字节点或文本框中没有这次查找的结果'
            : '全画布没有这次查找的结果');
        }

        // Reserve the next index immediately so several intentional clicks keep
        // their order. The governed task starts after this command leaves the
        // serialized command queue, avoiding a nested-command deadlock.
        navigationState = target.state;
        const task = context.tasks.schedule<void>({
          category: 'search-navigation',
          label: '定位画布查找结果',
          delayMs: 1,
          noticeAfterMs: 10_000,
          priority: 95,
          timeoutMs: 10_000,
          estimatedCost: 0,
          run: async (signal) => {
            if (signal.aborted || latestResult?.requestId !== source.requestId) return;
            if (scope.selectionAvailable) {
              expectedNavigationSelections.push([target.hit.nodeId]);
              await context.commands.dispatch('selection.set', {
                items: [{ id: target.hit.nodeId, kind: 'text-node' }],
                mode: 'replace',
              });
            }
            if (target.hit.field === 'body') {
              try {
                await context.commands.dispatch('editor.open', {
                  id: target.hit.nodeId,
                  reveal: {
                    start: target.hit.start,
                    end: target.hit.start + target.hit.length,
                    revision: target.hit.revision,
                  },
                });
              } catch {
                // Canvas selection remains the navigation feedback when the optional editor is unavailable.
              }
            }
            if (signal.aborted || latestResult?.requestId !== source.requestId) return;
            highlightedHit = target.hit;
            context.signals.emit('search.match.preview', {
              nodeId: target.hit.nodeId,
              field: target.hit.field,
              start: target.hit.start,
              length: target.hit.length,
            } satisfies SearchMatchPreview);
            context.signals.emit('search.navigation', target.state);
            context.signals.emit('search.status', {
              requestId: source.requestId,
              state: 'ready',
              message: target.state.scope === 'selection'
                ? `所选 ${target.state.scopeNodeCount} 个节点：第 ${target.state.index + 1} / ${target.state.total} 处`
                : `全画布：第 ${target.state.index + 1} / ${target.state.total} 处`,
            } satisfies SearchStatus);
          },
        });
        void task.result.catch((error) => {
          if (isAbortError(error)) return;
          if (latestResult?.requestId === source.requestId &&
            navigationState?.nodeId === target.state.nodeId &&
            navigationState.index === target.state.index) {
            clearNavigation();
          }
          context.signals.emit('search.status', {
            requestId: source.requestId,
            state: 'error',
            message: error instanceof Error ? error.message : String(error),
          } satisfies SearchStatus);
        });
        return { result: target.state };
      };
      context.commands.register({ type: 'search.previous', handle: () => navigate(-1) });
      context.commands.register({ type: 'search.next', handle: () => navigate(1) });
      context.commands.register<FloatingPanelRect>({
        type: 'search.setPanelRect',
        validate: isFloatingRect,
        handle: (payload) => ({
          transaction: {
            label: '调整查找替换窗口',
            history: false,
            patches: [{
              op: 'set',
              domain: 'workspace',
              namespace: SEARCH_NAMESPACE,
              key: 'panelRect',
              value: normalizeFloatingRect(payload, DEFAULT_SEARCH_RECT),
            }],
          },
        }),
      });

      context.commands.register<SearchRequest, { requestId: string; taskId: string }>({
        type: 'search.run',
        validate: isSearchRequest,
        handle: (payload) => {
          debounceTask?.cancel();
          debounceTask = undefined;
          activeTask?.cancel();
          latestRequest = { ...payload };
          const requestId = createId('search');
          const status: SearchStatus = { requestId, state: 'running', message: '正在按块扫描标题和正文' };
          context.signals.emit('search.status', status);
          const task = context.tasks.schedule<SearchResult>({
            category: 'content-search',
            label: payload.scope === 'canvas' ? '正在查找全画布内容' : '正在查找当前节点内容',
            priority: 45,
            timeoutMs: 2 * 60_000,
            estimatedCost: payload.scope === 'canvas' ? 10 : 1,
            run: async (signal, report) => {
              report(0.05);
              const nodeIds = payload.scope === 'current' ? await resolveCurrentNode(context) : undefined;
              const request: ContentSearchRequest = {
                query: payload.query,
                nodeIds,
                matchCase: payload.matchCase,
                wholeWord: payload.wholeWord,
                maxResults: 1000,
              };
              const result = await context.capabilities.request<ContentSearchResultV2>(
                'content.search@2',
                request,
                signal,
              );
              report(1);
              return { ...result, requestId, query: payload.query, scope: payload.scope };
            },
          });
          activeTask = task;
          void task.result.then(
            (result) => {
              if (activeTask?.id !== task.id) return;
              latestResult = result;
              clearNavigation();
              context.signals.emit('search.results', result);
              context.signals.emit('search.status', {
                requestId,
                state: 'ready',
                message: result.truncated ? '结果达到上限，请缩小范围' : `找到 ${result.hits.length} 处`,
              } satisfies SearchStatus);
              void revealPendingResult(result);
            },
            (error) => {
              if (activeTask?.id !== task.id || isAbortError(error)) return;
              context.signals.emit('search.status', {
                requestId,
                state: 'error',
                message: error instanceof Error ? error.message : String(error),
              } satisfies SearchStatus);
            },
          );
          return { result: { requestId, taskId: task.id } };
        },
      });

      context.signals.subscribe<SearchQueryPreview>('search.query.preview', (message) => {
        if (!isSearchQueryPreview(message.payload)) return;
        pendingNavigation = undefined;
        latestResult = undefined;
        clearNavigation();
        debounceTask?.cancel();
        activeTask?.cancel();
        context.signals.emit('search.results.clear', {});
        if (message.payload.query.length > 512) {
          context.signals.emit('search.status', {
            state: 'error',
            message: '查找内容最多 512 个字符',
          } satisfies SearchStatus);
          return;
        }
        if (message.payload.composing) {
          context.signals.emit('search.status', {
            state: 'idle',
            message: '输入完成后自动查找',
          } satisfies SearchStatus);
          return;
        }
        if (!message.payload.query) {
          latestRequest = undefined;
          context.signals.emit('search.status', { state: 'idle' } satisfies SearchStatus);
          return;
        }
        const request: SearchRequest = {
          query: message.payload.query,
          scope: 'canvas',
          matchCase: message.payload.matchCase,
          wholeWord: message.payload.wholeWord,
        };
        context.signals.emit('search.status', {
          state: 'idle',
          message: '等待输入完成后自动查找',
        } satisfies SearchStatus);
        const task = context.tasks.schedule<void>({
          category: 'search-debounce',
          label: '等待输入完成后自动查找',
          priority: 70,
          noticeAfterMs: 10_000,
          timeoutMs: 5_000,
          estimatedCost: 0,
          run: async (signal) => {
            await waitForDelay(280, signal);
            if (debounceTask?.id === task.id) debounceTask = undefined;
            await context.commands.dispatch('search.run', request);
          },
        });
        debounceTask = task;
        void task.result.catch((error) => {
          if (isAbortError(error)) return;
          context.signals.emit('search.status', {
            state: 'error',
            message: error instanceof Error ? error.message : String(error),
          } satisfies SearchStatus);
        });
      });

      const createReplacement = async (
        payload: ContentReplaceRequest,
        navigation?: ReplacementNavigationAnchor,
      ) => {
        const plan = await context.capabilities.request<ContentReplacePlan>(
          'content.replacePlan@2',
          payload,
        );
        if (plan.patches.length === 0) return { result: { replaced: 0 } };
        return {
          result: { replaced: plan.replaced },
          transaction: {
            label: `替换 ${plan.replaced} 处内容`,
            patches: plan.patches,
            events: [
              ...(plan.events ?? []),
              {
                type: 'search.replaced',
                payload: { replaced: plan.replaced, affectedNodes: plan.affectedNodes, navigation },
              },
            ],
          },
        };
      };

      context.commands.register<ContentReplaceRequest, { replaced: number }>({
        type: 'search.replace',
        validate: isReplaceRequest,
        handle: (payload) => createReplacement(payload),
      });

      context.commands.register<SearchReplaceTargetsRequest, { replaced: number }>({
        type: 'search.replaceTargets',
        validate: isReplaceTargetsRequest,
        handle: async (payload) => {
          const selectedNodeIds = [...new Set(payload.selectedNodeIds)];
          if (payload.currentHit) {
            if (payload.currentHit.field !== 'title') {
              const selection = await context.capabilities.request<EditorSelectionSnapshot | undefined>(
                'editor.selection@1',
              );
              if (!selection ||
                selection.id !== payload.currentHit.nodeId ||
                selection.start !== payload.currentHit.start ||
                selection.end !== payload.currentHit.start + payload.currentHit.length) {
                throw new Error('当前文本编辑区选中的内容已经变化，请重新选择一处查找结果');
              }
            } else if (!highlightedHit || !sameSearchHit(highlightedHit, payload.currentHit)) {
              throw new Error('当前标题高亮已经变化，请重新定位这一处查找结果');
            }
            const currentHit = payload.hits.find((hit) => sameSearchHit(hit, payload.currentHit!));
            if (!currentHit) throw new Error('当前选中的查找结果已经失效，请等待重新检索');
            return createReplacement(
              { hits: [currentHit], replacement: payload.replacement },
              currentHit.field === 'body' ? {
                nodeId: currentHit.nodeId,
                afterStart: currentHit.start + payload.replacement.length,
              } : undefined,
            );
          }
          if (latestResult?.truncated) {
            throw new Error('查找结果达到上限，不能执行不完整的批量替换');
          }
          const targets = selectedNodeIds.length > 0 ? new Set(selectedNodeIds) : undefined;
          const hits = targets ? payload.hits.filter((hit) => targets.has(hit.nodeId)) : payload.hits;
          if (hits.length === 0) {
            throw new Error(selectedNodeIds.length > 0
              ? '所选节点中没有可替换的结果'
              : '全画布没有可替换的结果');
          }
          return createReplacement({ hits, replacement: payload.replacement });
        },
      });

      context.events.subscribe('search.replaced', (message) => {
        const payload = isRecord(message.payload) ? message.payload : {};
        const request = latestRequest;
        const navigation = isReplacementNavigationAnchor(payload.navigation)
          ? payload.navigation
          : undefined;
        pendingNavigation = request && navigation
          ? { ...navigation, query: request.query }
          : undefined;
        context.signals.emit('search.status', {
          state: 'replaced',
          message: request
            ? `已替换 ${typeof payload.replaced === 'number' ? payload.replaced : 0} 处，正在重新检索`
            : `已替换 ${typeof payload.replaced === 'number' ? payload.replaced : 0} 处`,
        } satisfies SearchStatus);
        if (request) void context.commands.dispatch('search.run', request);
      });
      context.events.subscribe('document.replaced', () => {
        activeTask?.cancel();
        latestResult = undefined;
        clearNavigation();
        pendingNavigation = undefined;
        context.signals.emit('search.status', {
          state: 'replaced',
          message: '已打开另一份画布，请重新查找',
        } satisfies SearchStatus);
      });
      context.events.subscribe('content.changed', () => {
        activeTask?.cancel();
        latestResult = undefined;
        clearNavigation();
        context.signals.emit('search.status', {
          state: 'replaced',
          message: '正文已修改，旧结果已失效，请重新查找',
        } satisfies SearchStatus);
      });
      context.events.subscribe('node.renamed', () => {
        activeTask?.cancel();
        latestResult = undefined;
        clearNavigation();
        context.signals.emit('search.status', {
          state: 'replaced',
          message: '标题已修改，旧结果已失效，请重新查找',
        } satisfies SearchStatus);
      });
      const publishEditorContext = () => {
        void context.capabilities.request<EditorContextSnapshot>('editor.context@1').then(
          (snapshot) => context.signals.emit('search.editorContext', snapshot),
          () => context.signals.emit('search.editorContext', { openPanes: [] } satisfies EditorContextSnapshot),
        );
      };
      context.events.subscribe('editor.panes.changed', publishEditorContext);
      context.events.subscribe('editor.active.changed', publishEditorContext);
      context.events.subscribe('selection.changed', (message) => {
        const selection = selectionSnapshotFromPayload(message.payload);
        if (!selection) return;
        const nodeIds = selection.items
          .filter((item) => item.kind === 'text-node')
          .map((item) => item.id);
        context.signals.emit('search.selection.preview', { nodeIds });
        const expectedIndex = expectedNavigationSelections.findIndex((ids) => sameIds(nodeIds, ids));
        if (expectedIndex >= 0) {
          expectedNavigationSelections.splice(expectedIndex, 1);
          return;
        }
        clearNavigation();
      });
      context.signals.subscribe('search.navigation.reset', () => clearNavigation());

      context.capabilities.provide({
        key: 'search.state@1',
        invoke: () => ({ open: isOpen(), rect: readRect() }),
      });

      context.ui.contribute({
        id: 'search.open-button',
        slot: 'top.primary',
        kind: 'button',
        label: '查找替换',
        icon: 'find-replace',
        group: 'assist',
        tooltip: '查找全画布标题和正文（Ctrl/⌘ + F）',
        command: 'search.open',
        priority: 20,
      });
      context.ui.contribute({
        id: 'search.panel',
        slot: 'overlay.floating',
        kind: 'view',
        label: '查找替换面板',
        component: panel,
        priority: -20,
      });
      context.ui.shortcut({
        id: 'search.open-shortcut',
        chord: 'mod+f',
        command: 'search.open',
        label: '打开查找替换',
      });
      context.ui.shortcut({
        id: 'search.close-shortcut',
        command: 'search.close',
        label: '关闭查找替换',
        category: '查找替换',
        allowInEditable: true,
      });
      context.ui.shortcut({
        id: 'search.previous-shortcut',
        chord: 'shift+f3',
        command: 'search.previous',
        label: '所选节点或全画布：上一个查找结果',
        category: '查找替换',
        allowInEditable: true,
      });
      context.ui.shortcut({
        id: 'search.next-shortcut',
        chord: 'f3',
        command: 'search.next',
        label: '所选节点或全画布：下一个查找结果',
        category: '查找替换',
        allowInEditable: true,
      });
      context.ui.action({
        id: 'search.open-action',
        label: '打开查找替换',
        command: 'search.open',
        category: '编辑',
        keywords: ['搜索', '替换', '全画布', 'find'],
        priority: 20,
      });
      if (isOpen()) context.ui.activateSurface('overlay.floating', 'search.panel', 'search.close');
    },

    stop() {
      debounceTask?.cancel();
      debounceTask = undefined;
      activeTask?.cancel();
      activeTask = undefined;
      latestRequest = undefined;
      latestResult = undefined;
      navigationState = undefined;
      navigationScope = undefined;
      expectedNavigationSelections = [];
      pendingNavigation = undefined;
      highlightedHit = undefined;
    },
  };
}

async function resolveCurrentNode(
  context: Parameters<NonNullable<PluginDefinition['start']>>[0],
): Promise<string[]> {
  let activeNode: string | undefined;
  try {
    activeNode = await context.capabilities.request<string | undefined>('editor.activeNode@1');
  } catch {
    // The editor is optional; a single selected node is the fallback current node.
  }
  if (!activeNode) {
    try {
      const selection = await context.capabilities.request<SelectionSnapshot>('selection.read@1');
      if (selection.ids.length === 1) activeNode = selection.ids[0];
    } catch {
      // Selection is optional as long as the editor supplies an active node.
    }
  }
  if (!activeNode) throw new Error('请先聚焦一个编辑器，或只选择一个文本节点');
  return [activeNode];
}

function isSearchRequest(payload: unknown): payload is SearchRequest {
  return (
    isRecord(payload) &&
    typeof payload.query === 'string' &&
    payload.query.length > 0 &&
    payload.query.length <= 512 &&
    (payload.scope === 'current' || payload.scope === 'canvas') &&
    typeof payload.matchCase === 'boolean' &&
    typeof payload.wholeWord === 'boolean'
  );
}

function isSearchQueryPreview(payload: unknown): payload is SearchQueryPreview {
  return (
    isRecord(payload) &&
    typeof payload.query === 'string' &&
    typeof payload.matchCase === 'boolean' &&
    typeof payload.wholeWord === 'boolean' &&
    typeof payload.composing === 'boolean'
  );
}

function isReplaceRequest(payload: unknown): payload is ContentReplaceRequest {
  return (
    isRecord(payload) &&
    Array.isArray(payload.hits) &&
    payload.hits.length > 0 &&
    typeof payload.replacement === 'string'
  );
}

function isReplaceTargetsRequest(payload: unknown): payload is SearchReplaceTargetsRequest {
  if (!isRecord(payload)) return false;
  const selectedNodeIds = payload.selectedNodeIds;
  return (
    isReplaceRequest(payload) &&
    Array.isArray(selectedNodeIds) &&
    selectedNodeIds.every((id: unknown) => typeof id === 'string' && id.length > 0) &&
    (payload.currentHit === undefined || isSearchHit(payload.currentHit))
  );
}

function isSearchHit(payload: unknown): payload is SearchResult['hits'][number] {
  return (
    isRecord(payload) &&
    typeof payload.nodeId === 'string' &&
    typeof payload.title === 'string' &&
    (payload.field === undefined || payload.field === 'title' || payload.field === 'body') &&
    Number.isInteger(payload.start) && (payload.start as number) >= 0 &&
    Number.isInteger(payload.length) && (payload.length as number) > 0 &&
    typeof payload.matchedText === 'string' &&
    typeof payload.preview === 'string' &&
    Number.isInteger(payload.revision) && (payload.revision as number) >= 0
  );
}

function isReplacementNavigationAnchor(payload: unknown): payload is ReplacementNavigationAnchor {
  return isRecord(payload) &&
    typeof payload.nodeId === 'string' && payload.nodeId.length > 0 &&
    Number.isInteger(payload.afterStart) && (payload.afterStart as number) >= 0;
}

function sameSearchHit(
  left: SearchHit,
  right: NonNullable<SearchReplaceTargetsRequest['currentHit']>,
): boolean {
  return left.nodeId === right.nodeId &&
    (left.field ?? 'body') === (right.field ?? 'body') &&
    left.start === right.start &&
    left.length === right.length &&
    left.revision === right.revision &&
    left.matchedText === right.matchedText;
}

function selectionSnapshotFromPayload(payload: unknown): SelectionSnapshot | undefined {
  if (!isRecord(payload) || !Array.isArray(payload.ids) || !Array.isArray(payload.items)) return undefined;
  if (!payload.ids.every((id) => typeof id === 'string') || !payload.items.every((item) => (
    isRecord(item) && typeof item.id === 'string' && typeof item.kind === 'string'
  ))) return undefined;
  return {
    ids: payload.ids as string[],
    items: payload.items as SelectionSnapshot['items'],
  };
}

function sameIds(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((id, index) => id === right[index]);
}

function isFloatingRect(value: unknown): value is FloatingPanelRect {
  return isRecord(value) && ['x', 'y', 'width', 'height'].every((key) => typeof value[key] === 'number');
}

function waitForDelay(durationMs: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) {
      reject(new DOMException('Aborted', 'AbortError'));
      return;
    }
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', abort);
      resolve();
    }, durationMs);
    const abort = () => {
      clearTimeout(timer);
      signal.removeEventListener('abort', abort);
      reject(new DOMException('Aborted', 'AbortError'));
    };
    signal.addEventListener('abort', abort, { once: true });
  });
}
