import { defineManifest } from '../manifest.ts';
import {
  SEMANTIC_PROVIDER_CHANGED_SIGNAL,
  SEMANTIC_PROVIDER_COMMANDS,
  SEMANTIC_PROVIDER_PERSONAL_QUERY,
  SEMANTIC_PROVIDER_STATE_QUERY,
} from '../../protocols/semantic.ts';

export const SEMANTIC_PROVIDER_NAMESPACE = 'semanticProvider';

export const semanticProviderManifest = defineManifest('semantic-provider', '远程语义检索', {
  category: 'provider',
  namespaces: [SEMANTIC_PROVIDER_NAMESPACE],
  namespaceDomains: { [SEMANTIC_PROVIDER_NAMESPACE]: 'workspace' },
  commands: Object.values(SEMANTIC_PROVIDER_COMMANDS),
  events: [
    'semantic.provider.configuration.changed',
    'content.changed',
    'nodes.deleted',
    'node.created',
    'node.renamed',
    'document.replaced',
  ],
  signals: [SEMANTIC_PROVIDER_CHANGED_SIGNAL],
  queries: [SEMANTIC_PROVIDER_STATE_QUERY, SEMANTIC_PROVIDER_PERSONAL_QUERY],
  optionalCapabilities: ['context.catalog@1', 'context.read@1'],
  providesCapabilities: ['context.semanticSearch@1'],
  permissions: [
    'store.own.read',
    'store.own.write',
    'content.context.read',
    'tasks.schedule',
    'network.ai.embed',
    'network.origin.manage',
  ],
});
