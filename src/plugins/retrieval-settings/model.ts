import { isRecord, type PluginDefinition } from '../../core/contracts.ts';
import { validateAIContextSearchRequest, type AIContextSearchContribution } from '../../protocols/ai.ts';
import type { RetrievalMode, RetrievalSettingsState, SemanticRetrievalRequest, SemanticRetrievalResult } from '../../protocols/retrieval.ts';
import { isAbortError } from '../../services/abort.ts';
import { UI_SURFACE_REVEALED_EVENT, uiSurfaceRevealed } from '../../protocols/ui.ts';
import { defineManifest } from '../manifest.ts';

const NAMESPACE = 'retrievalSettings';
const modes: readonly RetrievalMode[] = ['keyword', 'local', 'cloud-fallback'];

/** Owns retrieval policy and its settings; providers retain their models, keys and indexes. */
export function createRetrievalSettingsPlugin(panel?: unknown): PluginDefinition {
  return {
    manifest: defineManifest('retrieval-settings', '检索设置', {
      namespaces: [NAMESPACE], namespaceDomains: { [NAMESPACE]: 'workspace' }, sessionOnlyWorkspace: { [NAMESPACE]: ['open'] },
      commands: ['retrieval.open@1', 'retrieval.close@1', 'retrieval.configure@1'], queries: ['retrieval.state@1'],
      optionalCapabilities: ['context.localSemanticSearch@1', 'context.remoteSemanticSearch@1'], providesCapabilities: ['context.semanticSearch@2'],
      events: ['retrieval.settings.changed@1', UI_SURFACE_REVEALED_EVENT], ui: ['retrieval-settings.panel'],
      permissions: ['store.own.read', 'store.own.write', 'content.context.read', 'ui.right.contribute'],
    }),
    start(context) {
      const mode = (): RetrievalMode => {
        const stored = context.store.readValue<RetrievalMode>(NAMESPACE, 'mode');
        return stored && modes.includes(stored) ? stored : 'local';
      };
      const patch = (key: string, value: unknown) => ({ op: 'set' as const, domain: 'workspace' as const, namespace: NAMESPACE, key, value });
      context.queries.register({ type: 'retrieval.state@1', handle: (): RetrievalSettingsState => ({ open: context.store.readValue(NAMESPACE, 'open') === true, mode: mode() }) });
      context.commands.register({ type: 'retrieval.open@1', handle: () => {
        context.ui.activateSurface('right.primary', 'retrieval-settings.panel', 'retrieval.close@1');
        return { transaction: { label: '打开检索设置', history: false, patches: [patch('open', true)], events: [
          { type: UI_SURFACE_REVEALED_EVENT, payload: uiSurfaceRevealed('right.primary', 'retrieval-settings', 'retrieval-settings.panel') },
        ] } };
      } });
      context.commands.register({ type: 'retrieval.close@1', handle: () => {
        context.ui.deactivateSurface('right.primary', 'retrieval-settings.panel');
        return { transaction: { label: '关闭检索设置', history: false, patches: [patch('open', false)] } };
      } });
      context.commands.register({ type: 'retrieval.configure@1', validate: (input): input is { mode: RetrievalMode } => isRecord(input) && modes.includes(input.mode as RetrievalMode), handle: input => ({
        transaction: { label: '设置检索方式', history: false, patches: [patch('mode', input.mode)], events: [{ type: 'retrieval.settings.changed@1', payload: { mode: input.mode } }] },
      }) });
      context.capabilities.provide<SemanticRetrievalRequest, SemanticRetrievalResult>({ key: 'context.semanticSearch@2', invoke: async (input, signal) => {
        validateAIContextSearchRequest(input);
        if (input.lexicalHits !== undefined && (!Number.isInteger(input.lexicalHits) || input.lexicalHits < 0)) throw new Error('关键词候选数量无效');
        const selectedMode = mode();
        const result: SemanticRetrievalResult = { mode: selectedMode, contributions: [], attempted: [], matched: [], warnings: [] };
        if (selectedMode === 'keyword' || input.sourceIds?.length === 0 || signal?.aborted) return result;
        const request = { ...input };
        delete request.lexicalHits;
        const search = async (kind: 'local' | 'cloud') => {
          result.attempted.push(kind);
          try {
            const parts = await context.capabilities.requestAll<AIContextSearchContribution>(kind === 'local' ? 'context.localSemanticSearch@1' : 'context.remoteSemanticSearch@1', request, signal);
            result.contributions.push(...parts);
            if (parts.some(part => part.hits.length)) result.matched.push(kind);
          } catch (error) {
            if (isAbortError(error)) throw error;
            result.warnings.push(kind === 'local' ? '本地语义检索暂不可用，已保留关键词结果。' : '云端补查暂不可用，已保留本地结果。');
            context.diagnostics.warn(result.warnings.at(-1)!, error);
          }
        };
        await search('local');
        const localIds = new Set(result.contributions.flatMap(part => part.hits.map(hit => hit.source.sourceId)));
        // A visible, deterministic coverage rule. It makes no confidence claim about vector scores.
        if (selectedMode === 'cloud-fallback' && (input.lexicalHits ?? 0) < 3 && localIds.size < 3 && mode() === selectedMode) await search('cloud');
        return result;
      } });
      context.ui.contribute({ id: 'retrieval-settings.panel', slot: 'right.primary', kind: 'view', label: '检索', component: panel,
        settings: { version: 1, label: '检索', icon: 'search', order: 45, openCommand: 'retrieval.open@1' }, priority: 80 });
    },
  };
}
