export type LocalSemanticIndexStatus = 'disabled' | 'idle' | 'dirty' | 'downloading' | 'indexing' | 'ready' | 'error';

export interface LocalSemanticProviderConfiguration {
  /** User-controlled and workspace-local; it is never written into the canvas document. */
  enabled: boolean;
}

export interface LocalSemanticProviderPanelState {
  enabled: boolean;
  modelLoaded: boolean;
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
  rebuild: 'localSemanticProvider.index.rebuild',
  cancelIndex: 'localSemanticProvider.index.cancel',
  clearRuntimeCache: 'localSemanticProvider.index.clearRuntimeCache',
} as const;

export const LOCAL_SEMANTIC_PROVIDER_STATE_QUERY = 'localSemanticProvider.state';
export const LOCAL_SEMANTIC_PROVIDER_CHANGED_SIGNAL = 'local.semantic.provider.changed';
