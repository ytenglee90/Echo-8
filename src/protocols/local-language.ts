import type { LocalSemanticModelId } from './local-semantic.ts';

export interface LocalLanguageRequest { texts: string[] }
export type LocalLanguageResult = { ready: true; modelId: LocalSemanticModelId; vectors: Float32Array[] } |
  { ready: false; reason: 'disabled' | 'unavailable' };

declare module './messages.ts' {
  interface ApplicationCapabilityMap {
    'language.embed@1': MessageContract<LocalLanguageRequest, LocalLanguageResult>;
  }
}
