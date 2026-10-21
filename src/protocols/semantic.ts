import type { CommandContract } from './commands.ts';

export type SemanticAPIStyle = 'openai-compatible' | 'voyage' | 'gemini';
export type SemanticAuthentication = 'bearer' | 'api-key' | 'none';

export interface SemanticProviderPreferences {
  endpoint: string;
  model: string;
  apiStyle: SemanticAPIStyle;
  authentication: SemanticAuthentication;
  /** Explicit permission to send bounded canvas excerpts while building the transient vector index. */
  allowRemoteContent: boolean;
  maxBatchSize: number;
}

export interface SemanticProviderProfile extends SemanticProviderPreferences {
  id: string;
  label: string;
  platform: string;
}

export interface SemanticProviderProfileDraft extends SemanticProviderPreferences {
  id?: string;
  label: string;
  platform: string;
}

export interface SemanticProviderProfileState extends SemanticProviderProfile {
  hasSessionKey: boolean;
  configured: boolean;
}

export interface SemanticProviderConfiguration {
  profiles: SemanticProviderProfile[];
  activeProfileId?: string;
}

/** Device-local connection material used only by the explicit AI personal TXT backup flow. */
export interface SemanticProviderPersonalConnections {
  configuration: SemanticProviderConfiguration;
  apiKeys: Record<string, string>;
}

export type SemanticIndexStatus = 'idle' | 'dirty' | 'indexing' | 'ready' | 'error';

export interface SemanticProviderPanelState {
  activeProfileId?: string;
  profiles: SemanticProviderProfileState[];
  cache: {
    status: SemanticIndexStatus;
    indexedSources: number;
    indexedChunks: number;
    totalSources: number;
    /** Sources too large for complete remote embedding coverage and indexed through bounded stratified blocks. */
    partialSources: number;
    lastBuiltAt?: number;
    error?: string;
  };
}

export const SEMANTIC_PROVIDER_COMMANDS = {
  saveProfile: 'semanticProvider.profile.save',
  removeProfile: 'semanticProvider.profile.remove',
  activateProfile: 'semanticProvider.profile.activate',
  setSessionKey: 'semanticProvider.setSessionKey',
  clearSessionKey: 'semanticProvider.clearSessionKey',
  rebuild: 'semanticProvider.index.rebuild',
  clearCache: 'semanticProvider.index.clear',
  restorePersonal: 'semanticProvider.restorePersonal',
} as const;

export const SEMANTIC_PROVIDER_STATE_QUERY = 'semanticProvider.state';
export const SEMANTIC_PROVIDER_PERSONAL_QUERY = 'semanticProvider.personalConnections';
export const SEMANTIC_PROVIDER_CHANGED_SIGNAL = 'semantic.provider.changed';

declare module './commands.ts' {
  interface ApplicationCommandMap {
    'semanticProvider.profile.save': CommandContract<SemanticProviderProfileDraft, { id: string }>;
  }
}
