import type {
  AIContextMode,
  AIContextSource,
  AIMemoryCandidateRecord,
  AIProposalRecord,
  AISessionRecord,
} from '../../protocols/ai.ts';
import type { FloatingPanelRect } from '../../protocols/floating.ts';

export const AI_COMPOSER_HEIGHT_MIN = 76;
export const AI_COMPOSER_HEIGHT_DEFAULT = 76;
export const AI_COMPOSER_HEIGHT_MAX = 1_000;
export const AI_GENERATION_ACTION_TTL_MS = 24 * 60 * 60_000;

export type AIAssistantView = 'chat' | 'memory' | 'prompt' | 'provider';

export interface AIAssistantInstanceState {
  id: string;
  sessionId: string;
  rect: FloatingPanelRect;
  composerHeight: number;
  view: AIAssistantView;
  /** Minimized assistants stay registered in the toolbar and keep their session. */
  minimized?: boolean;
  /** Workspace-only composer draft captured through the ephemeral draft channel. */
  draft?: string;
  providerProfileId?: string;
  /** Per-assistant workspace setting; it is not written into the portable canvas document. */
  webSearchEnabled?: boolean;
  promptTemplateId?: string;
  /** Empty means this assistant may automatically retrieve from every enabled memory. */
  memorySourceIds?: string[];
  /** When enabled, automatic memory and full-text retrieval are excluded from requests. */
  contextMode?: AIContextMode;
  /** Opt-in: run a separate low-output model call after each completed answer to propose memory candidates. */
  autoMemoryCandidates?: boolean;
  createdAt: number;
}

export interface AIAssistantState {
  open: boolean;
  rect: FloatingPanelRect;
  composerHeight: number;
  view: AIAssistantView;
  activeSessionId?: string;
  assistants: AIAssistantInstanceState[];
  sessions: AISessionRecord[];
  /** Suggestions remain inert until the user explicitly accepts one. */
  memoryCandidates: AIMemoryCandidateRecord[];
  proposals: AIProposalRecord[];
  responseDetails: AIResponseDetail[];
  lastMemoryUseBySession: Record<string, {
    sourceIds: string[];
    candidatesMatched: number;
    evidenceMemories: number;
    at: number;
  }>;
  /** Personal file-system link; the directory handle never enters the canvas document. */
  memoryFiles: {
    linked: boolean;
    directoryName?: string;
    writingSourceIds: string[];
    lastError?: string;
  };
  generationRuntimeBySession: Record<string, {
    state: 'generating' | 'error';
    message: string;
    preparationId?: string;
    sequence: number;
    text: string;
    reasoning: string;
  }>;
  /** Runtime-only action for the most recent send; it never enters document or workspace persistence. */
  generationActionBySession: Record<string, AIGenerationAction>;
}

export interface AIGenerationAction {
  kind: 'retry' | 'repeat';
  preparationId?: string;
  expiresAt: number;
}

export interface AIResponseDetail {
  id: string;
  sessionId: string;
  turn: number;
  /** Optional provider reasoning shown separately from the answer. */
  reasoning?: string;
  /** Stable provenance for every numbered canvas citation used by this answer. */
  citations?: AIResponseCitation[];
  createdAt: number;
}

export interface AIResponseCitation {
  ordinal: number;
  sourceId: string;
  title: string;
  kind: string;
  revision: number;
}

export interface AITranscriptSnapshot {
  sessionId: string;
  nodeId: string;
  revision: number;
  text: string;
  totalLength: number;
}

export interface AICatalogSnapshot {
  sources: AIContextSource[];
}

export function normalizeAIComposerHeight(value: unknown, panelHeight: number): number {
  const availableMaximum = Math.max(
    AI_COMPOSER_HEIGHT_MIN,
    Math.min(AI_COMPOSER_HEIGHT_MAX, Math.round(panelHeight) - 190),
  );
  const candidate = typeof value === 'number' && Number.isFinite(value)
    ? Math.round(value)
    : AI_COMPOSER_HEIGHT_DEFAULT;
  return Math.max(AI_COMPOSER_HEIGHT_MIN, Math.min(availableMaximum, candidate));
}
