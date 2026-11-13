import type { AIContextSearchContribution, AIContextSearchRequest } from './ai.ts';

export type RetrievalMode = 'keyword' | 'local' | 'cloud-fallback';
export interface SemanticRetrievalRequest extends AIContextSearchRequest {
  /** Unique verified keyword candidates already available for this query. */
  lexicalHits?: number;
}
export interface SemanticRetrievalResult {
  contributions: AIContextSearchContribution[];
  mode: RetrievalMode;
  attempted: Array<'local' | 'cloud'>;
  matched: Array<'local' | 'cloud'>;
  warnings: string[];
}
export interface RetrievalSettingsState {
  open: boolean;
  mode: RetrievalMode;
}

declare module './commands.ts' {
  interface ApplicationCommandMap {
    'retrieval.open@1': CommandContract<undefined, unknown>;
    'retrieval.close@1': CommandContract<undefined, unknown>;
    'retrieval.configure@1': CommandContract<{ mode: RetrievalMode }, unknown>;
  }
}
declare module './messages.ts' {
  interface ApplicationQueryMap {
    'retrieval.state@1': MessageContract<undefined, RetrievalSettingsState>;
  }
  interface ApplicationCapabilityMap {
    'context.localSemanticSearch@1': MessageContract<AIContextSearchRequest, AIContextSearchContribution>;
    'context.remoteSemanticSearch@1': MessageContract<AIContextSearchRequest, AIContextSearchContribution>;
    'context.semanticSearch@2': MessageContract<SemanticRetrievalRequest, SemanticRetrievalResult>;
  }
}
