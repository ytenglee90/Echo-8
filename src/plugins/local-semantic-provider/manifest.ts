import { defineManifest } from '../manifest.ts';
import {
  LOCAL_SEMANTIC_PROVIDER_CHANGED_SIGNAL,
  LOCAL_SEMANTIC_PROVIDER_COMMANDS,
  LOCAL_SEMANTIC_PROVIDER_STATE_QUERY,
} from '../../protocols/local-semantic.ts';
import {
  LOCAL_SEMANTIC_DECODE_CACHE_JOB,
  LOCAL_SEMANTIC_DISPOSE_MODEL_JOB,
  LOCAL_SEMANTIC_EMBED_JOB,
  LOCAL_SEMANTIC_ENCODE_CACHE_JOB,
  LOCAL_SEMANTIC_LOAD_MODEL_JOB,
} from './worker-protocol.ts';

export const LOCAL_SEMANTIC_PROVIDER_NAMESPACE = 'localSemanticProvider';

export const localSemanticProviderManifest = defineManifest('local-semantic-provider', '本地语义检索', {
  category: 'provider',
  namespaces: [LOCAL_SEMANTIC_PROVIDER_NAMESPACE],
  namespaceDomains: { [LOCAL_SEMANTIC_PROVIDER_NAMESPACE]: 'workspace' },
  commands: Object.values(LOCAL_SEMANTIC_PROVIDER_COMMANDS),
  dispatches: ['system.personalAssets.set'],
  events: ['content.changed', 'nodes.deleted', 'node.created', 'node.renamed', 'document.replaced'],
  signals: [LOCAL_SEMANTIC_PROVIDER_CHANGED_SIGNAL],
  queries: [LOCAL_SEMANTIC_PROVIDER_STATE_QUERY],
  asks: ['system.personalAssets.get'],
  optionalCapabilities: ['context.catalog@1', 'context.read@1'],
  providesCapabilities: ['context.semanticSearch@1'],
  ui: ['local-semantic-provider.settings'],
  workerJobs: [
    LOCAL_SEMANTIC_LOAD_MODEL_JOB,
    LOCAL_SEMANTIC_EMBED_JOB,
    LOCAL_SEMANTIC_DISPOSE_MODEL_JOB,
    LOCAL_SEMANTIC_ENCODE_CACHE_JOB,
    LOCAL_SEMANTIC_DECODE_CACHE_JOB,
  ],
  permissions: [
    'store.own.read',
    'store.own.write',
    'content.context.read',
    'tasks.schedule',
    'workers.run',
    'network.ai.model',
    'personal.assets.manage',
    'ui.ai-settings.contribute',
  ],
});
