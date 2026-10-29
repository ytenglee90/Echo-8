import type { EventDeclaration, PatchOperation } from './state.ts';

export type AIOperation =
  | 'general'
  | 'polish'
  | 'expand'
  | 'shorten'
  | 'name'
  | 'summarize'
  | 'outline'
  | 'detailed-outline'
  | 'rewrite'
  | 'translate'
  | 'classify'
  | 'extract'
  | 'compare'
  | 'verify'
  | 'analyze'
  | 'plan'
  | 'decompose'
  | 'evaluate'
  | 'simulate'
  | 'decide'
  | 'brainstorm'
  | 'script'
  | 'copywriting';

/** Controls whether a request may add memories discovered automatically by retrieval. */
export type AIContextMode = 'automatic' | 'explicit-only';
export type AIContextIntent = 'conversation' | 'memory-recall' | 'analysis';

export interface AIContextSource {
  sourceId: string;
  provider: string;
  kind: string;
  title: string;
  revision: number;
  length: number;
  /** False keeps a source explicitly referenceable while excluding it from automatic lexical/semantic retrieval. */
  automaticRetrieval?: boolean;
}

export interface AIContextCatalogContribution {
  provider: string;
  sources: AIContextSource[];
}

export interface AIContextReadRequest {
  sourceId: string;
  start: number;
  length: number;
}

export interface AIContextReadContribution {
  handled: boolean;
  source?: AIContextSource;
  start?: number;
  text?: string;
}

export interface AIContextSearchRequest {
  terms: string[];
  maxResults: number;
  /** Original natural-language query used for phrase boosts or optional semantic providers. */
  query?: string;
  /** Optional provider-produced expansions; callers must keep the original terms as well. */
  expandedTerms?: string[];
  sourceIds?: string[];
}

export interface AIContextSearchHit {
  source: AIContextSource;
  start: number;
  length: number;
  preview: string;
  score: number;
  matchedTerms?: string[];
  retrievalMethod?: 'exact' | 'bm25' | 'semantic' | 'hybrid';
}

export interface AIContextSearchContribution {
  provider: string;
  hits: AIContextSearchHit[];
  scanned: number;
}

export interface AIPreparedSource {
  sourceId: string;
  provider: string;
  kind: string;
  title: string;
  revision: number;
  start: number;
  length: number;
  text: string;
  estimatedTokens?: number;
  reason: 'explicit-reference' | 'recent-conversation' | 'conversation-memory' | 'keyword-match';
  /** Describes the structural boundary used to keep evidence readable instead of slicing blindly. */
  boundary?:
    | 'conversation-turn'
    | 'code-block'
    | 'markdown-table'
    | 'markdown-list'
    | 'paragraph'
    | 'sentence'
    | 'range';
  complete?: boolean;
  staleIndexRevision?: number;
}

export interface AIInlineReference {
  token: string;
  sourceId: string;
}

export interface AIPreparedContext {
  id: string;
  sessionId: string;
  /** Window identity captured for assistant-local policies such as opt-in candidate extraction. */
  assistantId?: string;
  prompt: string;
  operation: AIOperation;
  providerProfileId?: string;
  promptTemplateId?: string;
  /** Captured when the request is prepared so later UI changes cannot mutate an in-flight generation. */
  webSearchEnabled?: boolean;
  /** Memories explicitly scoped to this assistant for the current preparation. */
  selectedMemorySourceIds?: string[];
  /** Non-default only: evidence was limited to the user-selected or @-referenced sources. */
  contextMode?: AIContextMode;
  /** Non-default routing decision, retained to explain why discovery retrieval was skipped. */
  contextIntent?: AIContextIntent;
  createdAt: number;
  expiresAt: number;
  totalCharacters: number;
  estimatedTokens: number;
  contextBudget?: {
    modelContextWindowTokens?: number;
    evidenceTokenLimit: number;
    evidenceCharacterLimit: number;
  };
  sources: AIPreparedSource[];
  memoryConflicts?: AIMemoryConflict[];
  memoryIssues?: AIMemoryIssue[];
  memoryRetrieval?: AIMemoryRetrievalReport;
  review?: {
    reason: 'unresolved-memory-conflict' | 'memory-state-change';
    message: string;
  };
}

export interface AIMemoryRetrievalReport {
  mode: 'batched-index-coverage';
  batchSize: number;
  batchesScanned: number;
  candidateLimit: number;
  candidatesMatched: number;
  usableCandidates: number;
  queryBranches: number;
  coveredBranches: number;
  evidenceMemories: number;
  deferredMemories: number;
  exhaustiveRequested: boolean;
  contextBudgetExhausted: boolean;
  evidenceCoveredBranches?: number;
  incompleteBlocksSkipped?: number;
  staleCandidates?: number;
  staleCandidatesRecovered?: number;
  /** Candidate sources supplemented by bounded, user-confirmed claim relations. */
  relationshipSources?: number;
  /** Original-source anchors located through bounded claim relations. */
  relationshipEvidence?: number;
}

/**
 * A normalized function call returned by an OpenAI-compatible chat provider.
 * Tool results are always produced locally by Echo-8; a provider never gets
 * an arbitrary function name or executable payload back from the canvas.
 */
export interface AIChatToolCall {
  id: string;
  name: string;
  arguments: string;
}

/** Provider-neutral subset of an OpenAI-compatible function definition. */
export interface AIToolDefinition {
  type: 'function';
  function: {
    name: string;
    description: string;
    parameters: Record<string, unknown>;
  };
}

export interface AIChatMessage {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string;
  /** Required on a tool result and identifies the immediately preceding call. */
  toolCallId?: string;
  /** Present only on the assistant message that requested local tools. */
  toolCalls?: AIChatToolCall[];
}

export interface AIGenerateRequest {
  messages: AIChatMessage[];
  temperature: number;
  maxOutputTokens: number;
  /** Selects one configured connection without mutating another assistant's choice. */
  providerId?: string;
  /** Requests the selected provider's verified native web-search/grounding feature. */
  webSearch?: boolean;
  /** Optional, bounded local functions exposed only to compatible providers. */
  tools?: AIToolDefinition[];
}

export type AIFinishReason = 'stop' | 'length' | 'content-filter' | 'tool-calls' | 'other';

export interface AIGenerateResult {
  text: string;
  /** Optional provider-returned reasoning. It is displayed separately and is not treated as answer evidence. */
  reasoning?: string;
  provider: string;
  model: string;
  usage?: { inputTokens?: number; outputTokens?: number };
  /** Normalized provider termination reason. `length` means the answer may be incomplete. */
  finishReason?: AIFinishReason;
  /** A completed local-tool request. It is never persisted as a document command. */
  toolCalls?: AIChatToolCall[];
  /** Enables an accurate user-visible completion status without storing tool output. */
  memorySearchUsed?: boolean;
}

export type AIGenerateStreamEvent =
  | { type: 'delta'; delta: string; channel?: 'answer' | 'reasoning' }
  | {
      type: 'tool-call';
      /** Provider stream index; one call can arrive over several chunks. */
      index: number;
      id?: string;
      name?: string;
      argumentsDelta?: string;
    }
  | {
      type: 'complete';
      usage?: { inputTokens?: number; outputTokens?: number };
      finishReason?: AIFinishReason;
    };

/**
 * The provider owns the network reader. Consumers iterate events and cancel
 * through the AbortSignal passed to the capability request.
 */
export interface AIGenerateStream {
  provider: string;
  model: string;
  events: AsyncIterable<AIGenerateStreamEvent>;
}

export interface AIGenerationDeltaSignal {
  preparationId: string;
  sessionId: string;
  sequence: number;
  delta: string;
  channel?: 'answer' | 'reasoning';
}

export interface AIPromptTemplateRecord {
  id: string;
  name: string;
  systemInstruction: string;
  userInstruction: string;
  createdAt: number;
  updatedAt: number;
}

export interface AIPromptTemplateCatalog {
  activeTemplateId?: string;
  templates: AIPromptTemplateRecord[];
}

export interface AIPromptPolicyRequest {
  operation: AIOperation;
  prompt: string;
  sourceKinds: string[];
  sourceCount: number;
  activeTemplateId?: string;
}

export interface AIPromptPolicyContribution {
  provider: string;
  priority?: number;
  systemInstructions?: string[];
  userInstructions?: string[];
  temperature?: number;
  maxOutputTokens?: number;
}

export interface AIProviderInfo {
  id: string;
  label: string;
  configured: boolean;
  endpoint?: string;
  model?: string;
  contextWindowTokens?: number;
  secretPersistence: 'session-only' | 'personal-local' | 'server';
}

export interface AIProviderOption {
  id: string;
  label: string;
  platform: string;
  model: string;
  contextWindowTokens?: number;
  configured: boolean;
  webSearchSupported?: boolean;
  webSearchLabel?: string;
  /** OpenAI-compatible connections may use Echo-8's strictly local read tools. */
  toolCallingSupported?: boolean;
}

export interface AIProviderCatalog {
  activeId?: string;
  options: AIProviderOption[];
}

export interface AIMemoryAnchor {
  term: string;
  start: number;
  length: number;
}

export type AIMemoryClaimKind = 'confirm' | 'modify' | 'deprecate' | 'branch';
export type AIMemoryClaimStatus = 'current' | 'candidate' | 'deprecated' | 'branch';

export interface AIMemoryClaimRecord {
  id: string;
  kind: AIMemoryClaimKind;
  status: AIMemoryClaimStatus;
  subject: string;
  value?: string;
  previousValue?: string;
  scope?: string;
  start: number;
  length: number;
  authority: 'user-explicit';
  /** Stable order inside one indexed transcript, used with memory creation time for version resolution. */
  sequence?: number;
}

export interface AIMemoryConflictEvidence {
  claimId: string;
  sourceId: string;
  title: string;
  value: string;
  status: AIMemoryClaimStatus;
  start: number;
  length: number;
  createdAt: number;
  effectiveStatus?: 'current' | 'superseded' | 'deprecated' | 'competing';
}

export interface AIMemoryConflict {
  key: string;
  subject: string;
  scope?: string;
  resolution: 'resolved-by-explicit-modification' | 'unresolved';
  currentValue?: string;
  evidence: AIMemoryConflictEvidence[];
}

export interface AIMemoryIssue {
  sourceId: string;
  title: string;
  reason: 'source-missing' | 'source-revision-changed' | 'index-node-missing' | 'hub-node-missing';
  recovery?: 'rebuild-pending' | 'current-source-verified';
}

export interface AIMemoryIndexRecord {
  sessionId: string;
  sourceId: string;
  title: string;
  schemaVersion?: 2;
  indexNodeId?: string;
  hubNodeId?: string;
  connectionIds?: string[];
  enabled?: boolean;
  scope?: string;
  updatedAt?: number;
  /** Stable identity suffix with a title-derived prefix; memory rename updates the local pair names. */
  localFileStem?: string;
  sourceRevision: number;
  sourceLength: number;
  summary: string;
  keywords: string[];
  anchors: AIMemoryAnchor[];
  claims?: AIMemoryClaimRecord[];
  createdAt: number;
}

/**
 * A model-suggested memory item. It is deliberately separate from indexed
 * claims: a candidate never influences retrieval or conflict resolution until
 * the user accepts it into the canonical conversation transcript.
 */
export interface AIMemoryCandidateRecord {
  id: string;
  sessionId: string;
  sourceId: string;
  sourceRevision: number;
  sourceStart: number;
  sourceLength: number;
  sourceQuote: string;
  kind: AIMemoryClaimKind;
  subject: string;
  value?: string;
  previousValue?: string;
  scope?: string;
  confidence: number;
  status: 'pending' | 'accepted' | 'dismissed';
  extractor: { provider: string; model: string };
  createdAt: number;
  updatedAt: number;
  acceptedAt?: number;
}

/** Untrusted model output before it is bound to a quoted source range. */
export interface AIMemoryCandidateDraft {
  kind: AIMemoryClaimKind;
  subject: string;
  value?: string;
  previousValue?: string;
  scope?: string;
  evidence: string;
  confidence?: number;
}

export type AIMemoryCatalogStatus =
  | 'ready'
  | 'paused'
  | 'source-missing'
  | 'source-revision-changed'
  | 'index-node-missing'
  | 'hub-node-missing';

export interface AIMemoryCatalogEntry {
  memory: AIMemoryIndexRecord;
  status: AIMemoryCatalogStatus;
}

export interface AIMemoryCatalogSnapshot {
  entries: AIMemoryCatalogEntry[];
  conflicts: AIMemoryConflict[];
  counts: {
    total: number;
    ready: number;
    paused: number;
    attention: number;
  };
}

export type AIMemoryIndexDraft = Omit<AIMemoryIndexRecord, 'sessionId' | 'sourceId' | 'title'>;

export interface AISessionRecord {
  id: string;
  title: string;
  /** Legacy canvases may still point at the old live text-node transcript. New conversations use plugin-owned chunks. */
  transcriptSourceId?: string;
  transcriptRevision?: number;
  transcriptLength?: number;
  transcriptEntries?: number;
  revision: number;
  turns: number;
  createdAt: number;
  updatedAt: number;
  savedAt?: number;
  savedTranscriptRevision?: number;
}

export interface AIProposalRecord {
  id: string;
  sessionId: string;
  operation: AIOperation;
  text: string;
  provider: string;
  model: string;
  sourceRefs: Array<Pick<AIPreparedSource, 'sourceId' | 'title' | 'revision' | 'start' | 'length' | 'reason'>>;
  status: 'pending' | 'accepted' | 'dismissed';
  createdAt: number;
  /** Present only when the request explicitly edits one referenced text node. */
  suggestedTarget?: {
    nodeId: string;
    title: string;
    expectedRevision: number;
    length: number;
  };
  acceptedNodeId?: string;
  acceptedTarget?: AIProposalTarget;
}

export type AIProposalTarget =
  | { mode: 'append'; nodeId: string; expectedRevision: number }
  | { mode: 'replace'; nodeId: string; expectedRevision: number; start: number; end: number };

export interface AIContentPlan {
  patches: PatchOperation[];
  events?: EventDeclaration[];
}

export interface AIStatusSignal {
  state: 'idle' | 'preparing' | 'indexing' | 'ready' | 'generating' | 'error' | 'complete';
  message: string;
  /** Present for conversation-local work so several assistant windows cannot consume one another's status. */
  sessionId?: string;
  taskId?: string;
  preparationId?: string;
  proposalId?: string;
}
