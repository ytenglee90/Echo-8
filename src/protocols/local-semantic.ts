export type LocalSemanticIndexStatus = 'disabled' | 'idle' | 'dirty' | 'downloading' | 'indexing' | 'ready' | 'error';
export type LocalSemanticModelId = 'small' | 'base';
export const LOCAL_SEMANTIC_MODELS = {
  small: { model: 'Xenova/bge-small-zh-v1.5', revision: '75c43b0', cacheKey: 'bge-small-zh-v1.5-index@1', dimensions: 512, downloadMB: 38, maxModelMiB: 32 },
  base: { model: 'Xenova/bge-base-zh-v1.5', revision: '71e50dc', cacheKey: 'bge-base-zh-v1.5-index@1', dimensions: 768, downloadMB: 117, maxModelMiB: 110 },
} as const;

export interface LocalSemanticProviderConfiguration {
  /** User-controlled and workspace-local; it is never written into the canvas document. */
  enabled: boolean;
  modelId?: LocalSemanticModelId;
}

export interface LocalSemanticProviderPanelState {
  enabled: boolean;
  modelLoaded: boolean;
  modelId?: LocalSemanticModelId;
  cache: {
    status: LocalSemanticIndexStatus;
    indexedSources: number;
    indexedChunks: number;
    totalSources: number;
    partialSources: number;
    lastBuiltAt?: number;
    error?: string;
    download?: {
      current: number;
      total: number;
      label: string;
    };
  };
}

export const LOCAL_SEMANTIC_PROVIDER_COMMANDS = {
  setEnabled: 'localSemanticProvider.setEnabled',
  setModel: 'localSemanticProvider.model.set@1',
  rebuild: 'localSemanticProvider.index.rebuild',
  cancelIndex: 'localSemanticProvider.index.cancel',
  clearRuntimeCache: 'localSemanticProvider.index.clearRuntimeCache',
} as const;

export const LOCAL_SEMANTIC_PROVIDER_STATE_QUERY = 'localSemanticProvider.state';
export const LOCAL_SEMANTIC_PROVIDER_CHANGED_SIGNAL = 'local.semantic.provider.changed';

declare module './commands.ts' {
  interface ApplicationCommandMap {
    'localSemanticProvider.index.cancel': CommandContract<undefined, unknown>;
    'localSemanticProvider.model.set@1': CommandContract<{ modelId: LocalSemanticModelId }, { modelId: LocalSemanticModelId }>;
  }
}
