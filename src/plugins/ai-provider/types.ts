import type { CommandContract } from '../../protocols/commands.ts';

export interface AIProviderPreferences {
  /** `novelforge-connector` delegates transport and authentication to the NovelForge capability owner. */
  transport?: 'http' | 'novelforge-connector';
  endpoint: string;
  model: string;
  /** User/provider-declared total context window. It is never guessed from a mutable model name. */
  contextWindowTokens?: number;
  authentication: 'bearer' | 'api-key' | 'none';
  apiStyle: 'openai' | 'gemini';
  /** Personal opt-in: send the bounded local `search_memory` tool to this connection. */
  memoryToolEnabled?: boolean;
  /** Provider API keys may be personal-local; NovelForge pairing tokens are never stored here. */
  secretPersistence?: 'personal-local' | 'session-only';
}

export interface AIProviderProfile extends AIProviderPreferences {
  id: string;
  label: string;
  platform: string;
}

export interface AIProviderProfileState extends AIProviderProfile {
  hasSessionKey: boolean;
  configured: boolean;
}

export interface AIProviderConfiguration {
  profiles: AIProviderProfile[];
  activeProfileId?: string;
}

export interface AIProviderPanelState extends AIProviderPreferences {
  activeProfileId?: string;
  profiles: AIProviderProfileState[];
  hasSessionKey: boolean;
  configured: boolean;
  personalBackupName?: string;
}

export interface AIProviderProfileDraft extends AIProviderPreferences {
  id?: string;
  label: string;
  platform: string;
}

declare module '../../protocols/commands.ts' {
  interface ApplicationCommandMap {
    'aiProvider.profile.save': CommandContract<AIProviderProfileDraft, { id: string }>;
  }
}
