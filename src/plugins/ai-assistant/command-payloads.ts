import { isRecord } from '../../core/contracts.ts';
import type { CommandContract } from '../../protocols/commands.ts';
import type {
  AIGenerateResult,
  AIInlineReference,
  AIMemoryClaimRecord,
  AIMemoryCandidateDraft,
  AIMemoryIndexDraft,
  AIContextMode,
  AIOperation,
  AIProposalTarget,
} from '../../protocols/ai.ts';
import type { FileDirectoryTarget, FileReadWriteTarget, FileSaveTarget } from '../../protocols/files.ts';
import type { FloatingPanelRect } from '../../protocols/floating.ts';
import { isAIOperation } from './operations.ts';
import {
  AI_COMPOSER_HEIGHT_MAX,
  AI_COMPOSER_HEIGHT_MIN,
  type AIAssistantInstanceState,
  type AIAssistantState,
  type AIAssistantView,
} from './types.ts';

export interface PreparePayload {
  assistantId?: string;
  sessionId: string;
  prompt: string;
  operation: AIOperation;
  providerProfileId?: string;
  webSearchEnabled?: boolean;
  promptTemplateId?: string;
  memorySourceIds?: string[];
  contextMode?: AIContextMode;
  references?: AIInlineReference[];
  autoStart?: boolean;
}

export interface SaveSessionPayload {
  sessionId?: string;
  automatic?: boolean;
}

export interface MemoryIdPayload {
  sourceId: string;
}

export interface SetMemoryEnabledPayload extends MemoryIdPayload {
  enabled: boolean;
}

export interface SetMemoryScopePayload extends MemoryIdPayload {
  scope: string;
}

export interface CommitMemoryRebuildPayload extends MemoryIdPayload {
  expectedSourceRevision: number;
  index: AIMemoryIndexDraft;
}

export interface CommitMemoryRequest {
  preparationId: string;
}

export interface PreparationIdPayload {
  preparationId: string;
}

export interface PromptTemplateIdPayload {
  templateId?: string;
}

export interface PromptTemplateExportPayload {
  templateId: string;
  destination: FileSaveTarget;
}

export interface PromptTemplateImportPayload {
  source: FileReadWriteTarget;
}

export interface ComposerHeightPayload {
  assistantId?: string;
  height: number;
}

export interface AssistantIdPayload {
  assistantId?: string;
}

export interface AssistantResourcePayload {
  assistantId: string;
  resourceId?: string;
}

export interface AssistantMemoriesPayload {
  assistantId: string;
  sourceIds: string[];
}

export interface AssistantWebSearchPayload {
  assistantId: string;
  enabled: boolean;
}

export interface AssistantContextModePayload {
  assistantId: string;
  mode: AIContextMode;
}

export interface AssistantAutoMemoryCandidatesPayload {
  assistantId: string;
  enabled: boolean;
}

export interface MemoryCandidateExtractPayload {
  assistantId: string;
  sourceStart?: number;
  sourceLength?: number;
}

export interface MemoryCandidateCommitPayload {
  sessionId: string;
  sourceId: string;
  sourceRevision: number;
  sourceStart: number;
  sourceLength: number;
  extractor: { provider: string; model: string };
  candidates: AIMemoryCandidateDraft[];
}

export interface MemoryCandidateIdPayload {
  candidateId: string;
}

export interface ContinueMemoryPayload extends MemoryIdPayload {
  assistantId: string;
}

export interface RenameMemoryPayload extends MemoryIdPayload {
  title: string;
}

export interface LinkMemoryDirectoryPayload {
  directory: FileDirectoryTarget;
}

export interface ImportMemoryFilesPayload {
  sources: FileReadWriteTarget[];
}

export interface CommitMemoryFileImportPayload {
  preparationId: string;
}

export interface AssistantDraftPreview {
  assistantId: string;
  draft: string;
}

export interface SessionIdPayload {
  sessionId: string;
}

export interface AssistantViewPayload extends AssistantIdPayload {
  view: AIAssistantView;
}

export interface AssistantRectPayload extends AssistantIdPayload {
  rect: FloatingPanelRect;
}

export interface GenerationCancelPayload {
  sessionId?: string;
}

export interface GenerationRetryPayload {
  sessionId: string;
}

export interface GenerationRecordPayload extends PreparationIdPayload, AIGenerateResult {}

export interface ProposalIdPayload {
  proposalId: string;
}

export interface AcceptProposalPayload extends ProposalIdPayload {
  target?: AIProposalTarget;
}

declare module '../../protocols/commands.ts' {
  interface ApplicationCommandMap {
    'ai.generation.record': CommandContract<GenerationRecordPayload, { proposalId?: string }>;
    'ai.generation.retry': CommandContract<GenerationRetryPayload, { queued: true; mode: 'retry' | 'repeat' }>;
    'ai.memory.candidates.commit': CommandContract<
      MemoryCandidateCommitPayload,
      { created: number; stale: boolean; duplicates: number }
    >;
    'ai.session.memory.commit': CommandContract<
      CommitMemoryRequest,
      { archiveNodeId: string; indexNodeId: string }
    >;
  }
}

export function isPreparePayload(payload: unknown): payload is PreparePayload {
  return isRecord(payload) &&
    (payload.assistantId === undefined || typeof payload.assistantId === 'string') &&
    typeof payload.sessionId === 'string' &&
    typeof payload.prompt === 'string' && payload.prompt.trim().length > 0 && payload.prompt.length <= 20_000 &&
    isAIOperation(payload.operation) &&
    (payload.providerProfileId === undefined || typeof payload.providerProfileId === 'string') &&
    (payload.webSearchEnabled === undefined || typeof payload.webSearchEnabled === 'boolean') &&
    (payload.promptTemplateId === undefined || typeof payload.promptTemplateId === 'string') &&
    (payload.contextMode === undefined || payload.contextMode === 'automatic' || payload.contextMode === 'explicit-only') &&
    (payload.memorySourceIds === undefined || (Array.isArray(payload.memorySourceIds) &&
      payload.memorySourceIds.length <= 50 && payload.memorySourceIds.every((sourceId) =>
        typeof sourceId === 'string' && sourceId.length > 0 && sourceId.length <= 200))) &&
    (payload.autoStart === undefined || typeof payload.autoStart === 'boolean') &&
    (payload.references === undefined || (Array.isArray(payload.references) && payload.references.length <= 32 &&
      payload.references.every((reference) => isRecord(reference) &&
        typeof reference.token === 'string' && reference.token.length > 0 && reference.token.length <= 96 &&
        typeof reference.sourceId === 'string' && reference.sourceId.length > 0 && reference.sourceId.length <= 200)));
}

export function isAssistantResourcePayload(value: unknown): value is AssistantResourcePayload {
  return isRecord(value) && typeof value.assistantId === 'string' && value.assistantId.length > 0 &&
    (value.resourceId === undefined || (typeof value.resourceId === 'string' && value.resourceId.length <= 200));
}

export function isAssistantWebSearchPayload(value: unknown): value is AssistantWebSearchPayload {
  return isRecord(value) && typeof value.assistantId === 'string' && value.assistantId.length > 0 &&
    typeof value.enabled === 'boolean';
}

export function isAssistantContextModePayload(value: unknown): value is AssistantContextModePayload {
  return isRecord(value) && typeof value.assistantId === 'string' && value.assistantId.length > 0 &&
    (value.mode === 'automatic' || value.mode === 'explicit-only');
}

export function isAssistantAutoMemoryCandidatesPayload(value: unknown): value is AssistantAutoMemoryCandidatesPayload {
  return isRecord(value) && typeof value.assistantId === 'string' && value.assistantId.length > 0 &&
    typeof value.enabled === 'boolean';
}

export function isMemoryCandidateExtractPayload(value: unknown): value is MemoryCandidateExtractPayload {
  return isRecord(value) && typeof value.assistantId === 'string' && value.assistantId.length > 0 &&
    (value.sourceStart === undefined || (Number.isInteger(value.sourceStart) && Number(value.sourceStart) >= 0)) &&
    (value.sourceLength === undefined || (Number.isInteger(value.sourceLength) && Number(value.sourceLength) > 0 &&
      Number(value.sourceLength) <= 100_000));
}

export function isMemoryCandidateCommitPayload(value: unknown): value is MemoryCandidateCommitPayload {
  return isRecord(value) && typeof value.sessionId === 'string' && value.sessionId.length > 0 &&
    typeof value.sourceId === 'string' && value.sourceId.length > 0 &&
    Number.isInteger(value.sourceRevision) && Number(value.sourceRevision) >= 0 &&
    Number.isInteger(value.sourceStart) && Number(value.sourceStart) >= 0 &&
    Number.isInteger(value.sourceLength) && Number(value.sourceLength) > 0 && Number(value.sourceLength) <= 100_000 &&
    isRecord(value.extractor) && typeof value.extractor.provider === 'string' &&
    typeof value.extractor.model === 'string' && Array.isArray(value.candidates) &&
    value.candidates.length <= 8 && value.candidates.every(isMemoryCandidateDraft);
}

export function isMemoryCandidateIdPayload(value: unknown): value is MemoryCandidateIdPayload {
  return isRecord(value) && typeof value.candidateId === 'string' && value.candidateId.length > 0;
}

export function isAssistantMemoriesPayload(value: unknown): value is AssistantMemoriesPayload {
  return isRecord(value) && typeof value.assistantId === 'string' && value.assistantId.length > 0 &&
    Array.isArray(value.sourceIds) && value.sourceIds.length <= 50 &&
    value.sourceIds.every((sourceId) => typeof sourceId === 'string' && sourceId.length > 0 && sourceId.length <= 200);
}

export function isContinueMemoryPayload(value: unknown): value is ContinueMemoryPayload {
  return isRecord(value) && typeof value.assistantId === 'string' && value.assistantId.length > 0 &&
    typeof value.sourceId === 'string' && value.sourceId.length > 0;
}

export function isRenameMemoryPayload(value: unknown): value is RenameMemoryPayload {
  return isRecord(value) && typeof value.sourceId === 'string' && value.sourceId.length > 0 &&
    typeof value.title === 'string' && value.title.trim().length > 0 && value.title.trim().length <= 120;
}

export function isLinkMemoryDirectoryPayload(value: unknown): value is LinkMemoryDirectoryPayload {
  return isRecord(value) && isFileDirectoryTarget(value.directory);
}

export function isImportMemoryFilesPayload(value: unknown): value is ImportMemoryFilesPayload {
  return isRecord(value) && Array.isArray(value.sources) && value.sources.length >= 2 && value.sources.length <= 100 &&
    value.sources.every(isFileReadWriteTarget);
}

export function isCommitMemoryFileImportPayload(value: unknown): value is CommitMemoryFileImportPayload {
  return isRecord(value) && typeof value.preparationId === 'string' && value.preparationId.length > 0;
}

export function isAssistantDraftPreview(value: unknown): value is AssistantDraftPreview {
  return isRecord(value) && typeof value.assistantId === 'string' && value.assistantId.length > 0 &&
    typeof value.draft === 'string' && value.draft.length <= 20_000;
}

export function isSessionIdPayload(value: unknown): value is SessionIdPayload {
  return isRecord(value) && typeof value.sessionId === 'string' && value.sessionId.length > 0 && value.sessionId.length <= 200;
}

export function isSaveSessionPayload(payload: unknown): payload is SaveSessionPayload | undefined {
  return payload === undefined || (isRecord(payload) &&
    (payload.sessionId === undefined || typeof payload.sessionId === 'string') &&
    (payload.automatic === undefined || typeof payload.automatic === 'boolean'));
}

export function isSetMemoryEnabledPayload(payload: unknown): payload is SetMemoryEnabledPayload {
  return isRecord(payload) && typeof payload.sourceId === 'string' && typeof payload.enabled === 'boolean';
}

export function isMemoryIdPayload(payload: unknown): payload is MemoryIdPayload {
  return isRecord(payload) && typeof payload.sourceId === 'string' && payload.sourceId.length > 0;
}

export function isSetMemoryScopePayload(payload: unknown): payload is SetMemoryScopePayload {
  return isRecord(payload) && typeof payload.sourceId === 'string' &&
    typeof payload.scope === 'string' && payload.scope.length <= 200;
}

export function isCommitMemoryRebuildPayload(payload: unknown): payload is CommitMemoryRebuildPayload {
  return isRecord(payload) && typeof payload.sourceId === 'string' && payload.sourceId.length > 0 &&
    Number.isInteger(payload.expectedSourceRevision) && isMemoryIndexDraft(payload.index);
}

export function isCommitMemoryRequest(payload: unknown): payload is CommitMemoryRequest {
  return isRecord(payload) && typeof payload.preparationId === 'string' && payload.preparationId.length > 0;
}

export function isMemoryIndexDraft(value: unknown): value is AIMemoryIndexDraft {
  return isRecord(value) && Number.isInteger(value.sourceRevision) && Number.isInteger(value.sourceLength) &&
    typeof value.summary === 'string' && value.summary.length <= 1_000 &&
    Array.isArray(value.keywords) && value.keywords.length <= 32 &&
    value.keywords.every((term) => typeof term === 'string' && term.length <= 64) &&
    Array.isArray(value.anchors) && value.anchors.length <= 128 &&
    value.anchors.every((anchor) => isRecord(anchor) && typeof anchor.term === 'string' &&
      Number.isInteger(anchor.start) && Number(anchor.start) >= 0 &&
      Number.isInteger(anchor.length) && Number(anchor.length) >= 0) &&
    (value.claims === undefined || (Array.isArray(value.claims) && value.claims.length <= 256 &&
      value.claims.every(isMemoryClaim))) &&
    typeof value.createdAt === 'number' && Number.isFinite(value.createdAt);
}

export function isPreparationIdPayload(payload: unknown): payload is PreparationIdPayload {
  return isRecord(payload) && typeof payload.preparationId === 'string';
}

export function isGenerationRecordPayload(payload: unknown): payload is GenerationRecordPayload {
  const finishReasons = new Set(['stop', 'length', 'content-filter', 'tool-calls', 'other']);
  return isRecord(payload) && typeof payload.preparationId === 'string' &&
    typeof payload.text === 'string' && payload.text.length > 0 &&
    payload.text.length <= 100_000 &&
    (payload.reasoning === undefined || (typeof payload.reasoning === 'string' && payload.reasoning.length <= 100_000)) &&
    typeof payload.provider === 'string' && typeof payload.model === 'string' &&
    (payload.finishReason === undefined || finishReasons.has(String(payload.finishReason)));
}

export function isProposalIdPayload(payload: unknown): payload is ProposalIdPayload {
  return isRecord(payload) && typeof payload.proposalId === 'string';
}

export function isAcceptProposalPayload(payload: unknown): payload is AcceptProposalPayload {
  return isRecord(payload) && typeof payload.proposalId === 'string' &&
    (payload.target === undefined || isProposalTarget(payload.target));
}

export function isAssistantIdPayload(value: unknown): value is AssistantIdPayload | undefined {
  return value === undefined || (isRecord(value) &&
    (value.assistantId === undefined || typeof value.assistantId === 'string'));
}

export function isAssistantViewCommandPayload(value: unknown): value is AIAssistantView | AssistantViewPayload {
  return isAssistantView(value) || (isRecord(value) &&
    (value.assistantId === undefined || typeof value.assistantId === 'string') &&
    isAssistantView(value.view));
}

export function isAssistantRectCommandPayload(value: unknown): value is FloatingPanelRect | AssistantRectPayload {
  return isFloatingRect(value) || (isRecord(value) &&
    (value.assistantId === undefined || typeof value.assistantId === 'string') &&
    isFloatingRect(value.rect));
}

export function isComposerHeightPayload(value: unknown): value is ComposerHeightPayload {
  return isRecord(value) &&
    (value.assistantId === undefined || typeof value.assistantId === 'string') &&
    typeof value.height === 'number' &&
    Number.isFinite(value.height) &&
    value.height >= AI_COMPOSER_HEIGHT_MIN &&
    value.height <= AI_COMPOSER_HEIGHT_MAX;
}

export function isGenerationCancelPayload(value: unknown): value is GenerationCancelPayload | undefined {
  return value === undefined || (isRecord(value) &&
    (value.sessionId === undefined || typeof value.sessionId === 'string'));
}

export function isGenerationRetryPayload(value: unknown): value is GenerationRetryPayload {
  return isRecord(value) && typeof value.sessionId === 'string' &&
    value.sessionId.length > 0 && value.sessionId.length <= 200;
}

export function isAssistantInstanceState(value: unknown): value is AIAssistantInstanceState {
  return isRecord(value) &&
    typeof value.id === 'string' && value.id.length > 0 &&
    typeof value.sessionId === 'string' && value.sessionId.length > 0 &&
    isFloatingRect(value.rect) &&
    typeof value.composerHeight === 'number' && Number.isFinite(value.composerHeight) &&
    isAssistantView(value.view) &&
    (value.minimized === undefined || typeof value.minimized === 'boolean') &&
    (value.draft === undefined || (typeof value.draft === 'string' && value.draft.length <= 20_000)) &&
    (value.providerProfileId === undefined || typeof value.providerProfileId === 'string') &&
    (value.webSearchEnabled === undefined || typeof value.webSearchEnabled === 'boolean') &&
    (value.promptTemplateId === undefined || typeof value.promptTemplateId === 'string') &&
    (value.contextMode === undefined || value.contextMode === 'automatic' || value.contextMode === 'explicit-only') &&
    (value.autoMemoryCandidates === undefined || typeof value.autoMemoryCandidates === 'boolean') &&
    (value.memorySourceIds === undefined || (Array.isArray(value.memorySourceIds) && value.memorySourceIds.length <= 50 &&
      value.memorySourceIds.every((sourceId) => typeof sourceId === 'string' && sourceId.length > 0 && sourceId.length <= 200))) &&
    typeof value.createdAt === 'number' && Number.isFinite(value.createdAt);
}

export function readAssistantView(value: unknown): AIAssistantState['view'] {
  return isAssistantView(value) ? value : 'chat';
}

export function isPromptTemplateIdPayload(value: unknown): value is PromptTemplateIdPayload {
  return isRecord(value) &&
    (value.templateId === undefined || (typeof value.templateId === 'string' && value.templateId.length <= 160));
}

export function isPromptTemplateExportPayload(value: unknown): value is PromptTemplateExportPayload {
  return isRecord(value) && typeof value.templateId === 'string' && value.templateId.length > 0 &&
    isFileSaveTarget(value.destination);
}

export function isPromptTemplateImportPayload(value: unknown): value is PromptTemplateImportPayload {
  return isRecord(value) && isFileReadWriteTarget(value.source);
}

function isMemoryClaim(value: unknown): value is AIMemoryClaimRecord {
  return isRecord(value) && typeof value.id === 'string' &&
    ['confirm', 'modify', 'deprecate', 'branch'].includes(String(value.kind)) &&
    ['current', 'candidate', 'deprecated', 'branch'].includes(String(value.status)) &&
    typeof value.subject === 'string' && value.subject.length > 0 && value.subject.length <= 120 &&
    (value.value === undefined || (typeof value.value === 'string' && value.value.length <= 500)) &&
    (value.previousValue === undefined || (typeof value.previousValue === 'string' && value.previousValue.length <= 500)) &&
    (value.scope === undefined || (typeof value.scope === 'string' && value.scope.length <= 80)) &&
    Number.isInteger(value.start) && Number(value.start) >= 0 &&
    Number.isInteger(value.length) && Number(value.length) >= 0 &&
    (value.sequence === undefined || (Number.isInteger(value.sequence) && Number(value.sequence) >= 0)) &&
    value.authority === 'user-explicit';
}

function isMemoryCandidateDraft(value: unknown): value is AIMemoryCandidateDraft {
  return isRecord(value) && ['confirm', 'modify', 'deprecate', 'branch'].includes(String(value.kind)) &&
    typeof value.subject === 'string' && value.subject.trim().length > 0 && value.subject.length <= 120 &&
    (value.value === undefined || (typeof value.value === 'string' && value.value.length <= 500)) &&
    (value.previousValue === undefined || (typeof value.previousValue === 'string' && value.previousValue.length <= 500)) &&
    (value.scope === undefined || (typeof value.scope === 'string' && value.scope.length <= 80)) &&
    typeof value.evidence === 'string' && value.evidence.trim().length >= 2 && value.evidence.length <= 500 &&
    (value.confidence === undefined || (typeof value.confidence === 'number' &&
      Number.isFinite(value.confidence) && value.confidence >= 0 && value.confidence <= 1));
}

function isProposalTarget(value: unknown): value is AIProposalTarget {
  if (!isRecord(value) || !['append', 'replace'].includes(String(value.mode))) return false;
  if (typeof value.nodeId !== 'string' || !Number.isInteger(value.expectedRevision)) return false;
  if (value.mode === 'append') return true;
  return Number.isInteger(value.start) && Number.isInteger(value.end) &&
    Number(value.start) >= 0 && Number(value.end) >= Number(value.start);
}

export function isFloatingRect(value: unknown): value is FloatingPanelRect {
  return isRecord(value) && ['x', 'y', 'width', 'height'].every((key) => typeof value[key] === 'number');
}

function isAssistantView(value: unknown): value is AIAssistantState['view'] {
  return value === 'chat' || value === 'memory' || value === 'prompt' || value === 'provider';
}

function isFileSaveTarget(value: unknown): value is FileSaveTarget {
  return Boolean(value) && typeof value === 'object' &&
    typeof (value as FileSaveTarget).name === 'string' &&
    typeof (value as FileSaveTarget).createWritable === 'function';
}

function isFileReadWriteTarget(value: unknown): value is FileReadWriteTarget {
  return isFileSaveTarget(value) && typeof (value as FileReadWriteTarget).getFile === 'function';
}

export function isFileDirectoryTarget(value: unknown): value is FileDirectoryTarget {
  return Boolean(value) && typeof value === 'object' &&
    typeof (value as FileDirectoryTarget).name === 'string' &&
    typeof (value as FileDirectoryTarget).getFileHandle === 'function';
}
