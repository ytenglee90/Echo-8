'use client';

import { useEffect, useState } from 'react';
import type { ViewClient } from '../../core/contracts.ts';
import type {
  AIPreparedContext,
  AIMemoryCatalogSnapshot,
  AIPromptTemplateCatalog,
  AIProviderCatalog,
} from '../../protocols/ai.ts';
import type { FloatingPanelRect } from '../../protocols/floating.ts';
import {
  AI_COMPOSER_HEIGHT_DEFAULT,
  type AIAssistantState,
  type AICatalogSnapshot,
  type AITranscriptSnapshot,
} from './types.ts';

const DEFAULT_RECT: FloatingPanelRect = { x: 720, y: 76, width: 520, height: 720 };
const EMPTY_STATE: AIAssistantState = {
  open: false,
  rect: DEFAULT_RECT,
  composerHeight: AI_COMPOSER_HEIGHT_DEFAULT,
  view: 'chat',
  assistants: [],
  sessions: [],
  memoryCandidates: [],
  proposals: [],
  responseDetails: [],
  lastMemoryUseBySession: {},
  memoryFiles: { linked: false, writingSourceIds: [] },
  generationRuntimeBySession: {},
  generationActionBySession: {},
};
const EMPTY_MEMORY_CATALOG: AIMemoryCatalogSnapshot = {
  entries: [], conflicts: [], counts: { total: 0, ready: 0, paused: 0, attention: 0 },
};
const EMPTY_PROMPT_CATALOG: AIPromptTemplateCatalog = { templates: [] };

type GenerationRuntime = AIAssistantState['generationRuntimeBySession'][string];

export function useAIWindowData({
  client,
  assistantId,
  ownVersion,
  capabilityVersion,
  stateVersion,
  catalogVersion,
  providerVersion,
  memoryVersion,
  transcriptVersion,
  setPrepared,
  restoreGenerationRuntime,
  onError,
}: {
  client: ViewClient;
  assistantId: string;
  ownVersion: number;
  capabilityVersion: number;
  stateVersion: number;
  catalogVersion: number;
  providerVersion: number;
  memoryVersion: number;
  transcriptVersion: number;
  setPrepared: (prepared: AIPreparedContext | undefined) => void;
  restoreGenerationRuntime: (runtime?: GenerationRuntime, sessionId?: string) => void;
  onError: (message: string) => void;
}) {
  const [state, setState] = useState<AIAssistantState>(EMPTY_STATE);
  const [catalog, setCatalog] = useState<AICatalogSnapshot>({ sources: [] });
  const [transcript, setTranscript] = useState<AITranscriptSnapshot>();
  const [providerCatalog, setProviderCatalog] = useState<AIProviderCatalog>({ options: [] });
  const [memoryCatalog, setMemoryCatalog] = useState<AIMemoryCatalogSnapshot>(EMPTY_MEMORY_CATALOG);
  const [promptCatalog, setPromptCatalog] = useState<AIPromptTemplateCatalog>(EMPTY_PROMPT_CATALOG);

  useEffect(() => {
    let current = true;
    void Promise.all([
      client.ask<AIAssistantState>('ai.state'),
      client.ask<AICatalogSnapshot>('ai.catalog'),
      client.request<AIProviderCatalog>('ai.provider.catalog@1').catch(() => ({ options: [] })),
      client.ask<AIPromptTemplateCatalog>('ai.promptTemplates').catch(() => EMPTY_PROMPT_CATALOG),
    ]).then(
      ([nextState, nextCatalog, nextProviderCatalog, nextPromptCatalog]) => {
        if (!current) return;
        const scoped = assistantScopedState(nextState, assistantId);
        setState(scoped);
        setCatalog(nextCatalog);
        setProviderCatalog(nextProviderCatalog);
        setPromptCatalog(nextPromptCatalog);
        const runtime = scoped.activeSessionId
          ? scoped.generationRuntimeBySession[scoped.activeSessionId]
          : undefined;
        restoreGenerationRuntime(runtime, scoped.activeSessionId);
      },
      (reason) => { if (current) onError(errorMessage(reason)); },
    );
    return () => { current = false; };
  }, [
    assistantId,
    catalogVersion,
    capabilityVersion,
    client,
    onError,
    ownVersion,
    providerVersion,
    restoreGenerationRuntime,
    stateVersion,
  ]);

  useEffect(() => {
    let current = true;
    // The chat view owns a per-assistant memory picker, so keep this catalog
    // warm for every open assistant instead of only inside the memory center.
    if (!state.open) return () => { current = false; };
    void client.ask<AIMemoryCatalogSnapshot>('ai.memoryCatalog').then(
      (next) => { if (current) setMemoryCatalog(next); },
      (reason) => { if (current) onError(errorMessage(reason)); },
    );
    return () => { current = false; };
  }, [client, memoryVersion, onError, state.open]);

  useEffect(() => {
    let current = true;
    if (!state.activeSessionId) return () => { current = false; };
    const sessionId = state.activeSessionId;
    void Promise.all([
      client.ask<AITranscriptSnapshot>('ai.transcript', { sessionId }),
      client.ask<AIPreparedContext | undefined>('ai.pendingPreparation', { sessionId }),
    ]).then(
      ([next, pending]) => {
        if (!current) return;
        setTranscript(next);
        if (!state.generationRuntimeBySession[sessionId]) setPrepared(pending);
      },
      (reason) => { if (current) onError(errorMessage(reason)); },
    );
    return () => { current = false; };
  }, [client, onError, setPrepared, state.activeSessionId, state.generationRuntimeBySession, transcriptVersion]);

  return { state, catalog, transcript, providerCatalog, memoryCatalog, promptCatalog };
}

function assistantScopedState(state: AIAssistantState, assistantId: string): AIAssistantState {
  const assistant = state.assistants.find((candidate) => candidate.id === assistantId);
  if (!assistant) return { ...state, open: false };
  return {
    ...state,
    open: assistant.minimized !== true,
    rect: assistant.rect,
    composerHeight: assistant.composerHeight,
    view: assistant.view,
    activeSessionId: assistant.sessionId,
  };
}

function errorMessage(reason: unknown): string {
  return reason instanceof Error ? reason.message : String(reason);
}
