'use client';

import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
  type CSSProperties,
  type ReactNode,
} from 'react';
import type { UISlot, ViewClient } from '../../core/contracts.ts';
import { FloatingPanel } from '../../ui/FloatingPanel.tsx';
import { useCommandAvailability } from '../../ui/runtime-hooks.ts';
import { AIMemoryCenter } from './AIMemoryViews.tsx';
import { AIAssistantWindowActions } from './AIAssistantWindowActions.tsx';
import { AIChatHeader } from './AIChatHeader.tsx';
import {
  AIChatEmptyState,
  AICommandHints,
  AIGenerationFollowupButton,
  AIMemorySuggestionNotice,
  AIStreamingResponse,
} from './AIChatPresentation.tsx';
import { AIComposer } from './AIComposer.tsx';
import { AIChatScrollbar } from './AIChatScrollbar.tsx';
import { AIPromptTemplateCenter } from './AIPromptTemplateCenter.tsx';
import {
  AIContextReview,
  AIWritebackReview,
} from './AIReviewViews.tsx';
import { AITranscriptView } from './AITranscriptView.tsx';
import { chooseAIMemoryDirectory } from './memory-directory-picker.ts';
import { inferMemorySuggestion } from './memory-suggestion.ts';
import { AI_UI_NAMESPACE } from './model.ts';
import {
  resolveAIWritebackTarget,
  type AIWritebackMode,
} from './proposal-writeback.ts';
import { useAIWindowData } from './use-ai-window-data.ts';
import { useAIDropZone } from './use-ai-drop-zone.ts';
import { useAIWindowSignals } from './use-ai-window-signals.ts';
import {
  type AIAssistantInstanceState,
  type AIAssistantState,
} from './types.ts';
import { useAIComposerController } from './use-ai-composer-controller.ts';

const AI_DROP_OWNER = 'ai-assistant';
export function AIAssistantPanel({
  client,
  renderSlot,
}: {
  client: ViewClient;
  renderSlot?: (slot: UISlot) => ReactNode;
}) {
  const stateVersion = useSyncExternalStore(client.subscribeState, client.getStateVersion, () => 0);
  const [assistants, setAssistants] = useState<AIAssistantInstanceState[]>([]);
  useEffect(() => {
    let current = true;
    void client.ask<AIAssistantState>('ai.state').then((state) => {
      if (current) setAssistants(state.assistants);
    });
    return () => { current = false; };
  }, [client, stateVersion]);
  return <>{assistants.filter((assistant) => assistant.minimized !== true).map((assistant) => (
    <AIAssistantWindow
      key={assistant.id}
      assistantId={assistant.id}
      client={client}
      renderSlot={renderSlot}
    />
  ))}</>;
}

function AIAssistantWindow({
  assistantId,
  client,
  renderSlot,
}: {
  assistantId: string;
  client: ViewClient;
  renderSlot?: (slot: UISlot) => ReactNode;
}) {
  const providerSelectionAvailable = useCommandAvailability(client, 'aiProvider.profile.activate');
  const providerSettingsAvailable = providerSelectionAvailable;
  const ownVersion = useSyncExternalStore(client.subscribeState, () => client.getOwnStateVersion(AI_UI_NAMESPACE), () => 0);
  const capabilityVersion = useSyncExternalStore(client.subscribeCapabilities, client.getCapabilityVersion, () => 0);
  const [outputProposalId, setOutputProposalId] = useState('');
  const [outputMode, setOutputMode] = useState<'append' | 'replace'>('replace');
  const [outputNodeId, setOutputNodeId] = useState('');
  const [error, setError] = useState('');
  const [dismissedMemorySuggestion, setDismissedMemorySuggestion] = useState('');
  const feedRef = useRef<HTMLDivElement>(null);
  const pendingSentScroll = useRef(false);
  const insertSourceReferenceRef = useRef<(sourceId: string) => void>(() => undefined);
  const activeSessionIdRef = useRef<string | undefined>(undefined);
  const transcriptNodeIdRef = useRef<string | undefined>(undefined);
  const dropOwner = `${AI_DROP_OWNER}:${assistantId}`;
  const handleReferenceDrop = useCallback((sourceId: string) => {
    insertSourceReferenceRef.current(sourceId);
  }, []);
  const {
    prepared,
    setPrepared,
    status,
    streamingResponse,
    restoreGenerationRuntime,
    stateVersion,
    catalogVersion,
    transcriptVersion,
    providerVersion,
    memoryVersion,
    referenceDropReady,
    composerPreviewHeight,
    focusToken,
  } = useAIWindowSignals({
    client,
    assistantId,
    activeSessionIdRef,
    transcriptNodeIdRef,
    dropOwner,
    onReferenceDrop: handleReferenceDrop,
  });
  const { state, catalog, transcript, providerCatalog, memoryCatalog, promptCatalog } = useAIWindowData({
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
    onError: setError,
  });

  useEffect(() => {
    activeSessionIdRef.current = state.activeSessionId;
    transcriptNodeIdRef.current = transcript?.nodeId;
  }, [state.activeSessionId, transcript?.nodeId]);

  const activeSession = state.sessions.find((session) => session.id === state.activeSessionId);
  const activeSessionId = activeSession?.id;
  const generationAction = activeSessionId
    ? state.generationActionBySession[activeSessionId]
    : undefined;
  const activeSessionTurns = activeSession?.turns ?? 0;
  const windowOpen = state.open;
  const assistantInstance = state.assistants.find((assistant) => assistant.id === assistantId);
  const selectedProviderId = assistantInstance?.providerProfileId ?? providerCatalog.activeId ?? '';
  const selectedProvider = providerCatalog.options.find((option) => option.id === selectedProviderId);
  const selectedPromptTemplate = promptCatalog.templates.find((template) =>
    template.id === assistantInstance?.promptTemplateId);
  const currentMemory = memoryCatalog.entries.find((entry) => entry.memory.sessionId === activeSession?.id)?.memory;
  const lastMemoryUse = activeSession ? state.lastMemoryUseBySession[activeSession.id] : undefined;
  const sessionProposals = useMemo(
    () => state.proposals
      .filter((proposal) => proposal.sessionId === state.activeSessionId && proposal.status === 'pending')
      .slice(0, 1),
    [state.activeSessionId, state.proposals],
  );
  const publishDropZone = useAIDropZone({
    client,
    owner: dropOwner,
    active: Boolean(windowOpen && activeSessionId),
  });
  const handleSubmitted = useCallback(() => {
    pendingSentScroll.current = true;
  }, []);
  const {
    prompt,
    setPrompt,
    textareaRef,
    composerHeight,
    composerProps,
    insertSourceReference,
    cancelComposition,
  } = useAIComposerController({
    client,
    assistantId,
    assistant: assistantInstance,
    activeSession,
    catalog,
    selectedProviderId,
    selectedProviderConfigured: selectedProvider?.configured === true,
    status: status.state,
    panelHeight: state.rect.height,
    stableHeight: state.composerHeight,
    previewHeight: composerPreviewHeight,
    dropReady: referenceDropReady,
    setPrepared,
    onSubmitted: handleSubmitted,
    onError: setError,
  });
  const memorySuggestion = useMemo(() => inferMemorySuggestion(prompt), [prompt]);

  useEffect(() => {
    if (!pendingSentScroll.current || !transcript?.text.trim()) return;
    const userBubbles = feedRef.current?.querySelectorAll<HTMLElement>('.ai-chat-bubble.user');
    const sent = userBubbles?.item((userBubbles.length ?? 0) - 1);
    if (!sent) return;
    pendingSentScroll.current = false;
    requestAnimationFrame(() => sent.scrollIntoView({ block: 'start', behavior: 'smooth' }));
  }, [transcript?.text]);
  useEffect(() => {
    insertSourceReferenceRef.current = insertSourceReference;
  }, [insertSourceReference]);

  if (!state.open) return null;

  const run = async (operationToRun: () => Promise<unknown>) => {
    setError('');
    try {
      await operationToRun();
    } catch (reason) {
      setError(errorMessage(reason));
    }
  };
  const hasConversation = Boolean(transcript?.text.trim());
  const saveCurrentSession = async () => {
    if (!activeSession) return;
    setError('');
    try {
      // The first explicit save establishes the user's local mirror in the
      // same gesture. This keeps the native directory picker where users
      // expect it, without turning saving into a two-click workflow.
      if (!state.memoryFiles.linked) {
        const directory = await chooseAIMemoryDirectory(client);
        if (!directory) throw new Error('当前浏览器不支持选择文件夹，请使用 Chromium 版 Echo-8');
        await client.dispatch('ai.memory.linkDirectory', { directory });
      }
      await client.dispatch('ai.session.save', { sessionId: activeSession.id });
    } catch (reason) {
      if ((reason as { name?: string })?.name !== 'AbortError') setError(errorMessage(reason));
    }
  };

  return (
    <FloatingPanel
      key={`${assistantId}:${focusToken}`}
      title="AI 助手"
      titleDetail={`记忆：${currentMemory?.title ?? '新对话'}`}
      titleDetailTitle={currentMemory
        ? `当前对话会继续写入“${currentMemory.title}”；上次回答读取 ${lastMemoryUse?.evidenceMemories ?? 0} 份记忆原文`
        : '这是尚未保存为记忆的新对话'}
      icon="sparkles"
      rect={state.rect}
      className="ai-floating-panel"
      localHistory
      onActivate={() => void client.dispatch('ai.assistant.activate', { assistantId })}
      onPreview={(rect) => {
        client.emit('ai.panel.preview', { assistantId, rect });
        publishDropZone(rect);
      }}
      onRenderedRectChange={publishDropZone}
      onCommit={(rect) => void client.dispatch('ai.setPanelRect', { assistantId, rect })}
      onClose={() => {
        cancelComposition();
        void client.dispatch('ai.close', { assistantId });
      }}
      headerActions={<AIAssistantWindowActions
        client={client}
        assistantId={assistantId}
        view={state.view}
        providerSettingsAvailable={providerSettingsAvailable}
        onError={setError}
      />}
    >
      {state.view === 'chat' ? <section
        className="ai-chat-shell"
        aria-label="AI 对话"
        style={{ '--ai-composer-height': `${composerHeight}px` } as CSSProperties}
      >
        <AIChatHeader
          client={client}
          assistantId={assistantId}
          providerSelectionAvailable={providerSelectionAvailable}
          providerCatalog={providerCatalog}
          selectedProviderId={selectedProviderId}
          selectedProvider={selectedProvider}
          webSearchEnabled={assistantInstance?.webSearchEnabled === true}
          selectedPromptTemplate={selectedPromptTemplate}
          memoryCatalog={memoryCatalog}
          selectedMemorySourceIds={new Set(assistantInstance?.memorySourceIds ?? [])}
          contextMode={assistantInstance?.contextMode ?? 'automatic'}
          onSelectProvider={(resourceId) => void run(() => client.dispatch(
            'ai.assistant.setProvider',
            { assistantId, resourceId },
          ))}
          onToggleWebSearch={() => void run(() => client.dispatch('ai.assistant.setWebSearch', {
            assistantId,
            enabled: !assistantInstance?.webSearchEnabled,
          }))}
          onOpenPromptTemplates={() => void client.dispatch('ai.setView', { assistantId, view: 'prompt' })}
        />

        <div className="ai-chat-feed-frame">
          <div
            id={`ai-chat-feed-${assistantId}`}
            ref={feedRef}
            className="ai-chat-feed"
            aria-live="polite"
            aria-description="双击右侧滚动条可跳到最新对话"
            data-native-clipboard="true"
          >
          {!activeSession && <AIChatEmptyState />}

          {activeSession && (
            <>
              {hasConversation ? (
                <AITranscriptView
                  text={transcript?.text ?? ''}
                  turns={activeSessionTurns}
                  sessionId={activeSessionId}
                  responseDetails={state.responseDetails}
                  currentSources={catalog.sources}
                  onOpenSource={(sourceId) => void run(() => client.dispatch('editor.open', { id: sourceId }))}
                />
              ) : <AICommandHints />}
              <div className="ai-status-row">
                <div className={`ai-status ai-status-${status.state}`} role="status"><i />{status.message}</div>
                {generationAction && (
                  <AIGenerationFollowupButton
                    kind={generationAction.kind}
                    disabled={status.state === 'preparing' || status.state === 'generating' || status.state === 'indexing'}
                    onClick={() => void run(() => client.dispatch('ai.generation.retry', {
                      sessionId: activeSessionId!,
                    }))}
                  />
                )}
              </div>
              {error && <p className="ai-error" role="alert">{error}</p>}

              {streamingResponse && <AIStreamingResponse
                text={streamingResponse.text}
                reasoning={streamingResponse.reasoning}
              />}

              {prepared?.review && (
                <AIContextReview
                  prepared={prepared}
                  providerConfigured={selectedProvider?.configured === true}
                  onConfirm={() => void run(async () => {
                    const preparationId = prepared.id;
                    setPrepared(undefined);
                    await client.dispatch('ai.generation.start', { preparationId });
                  })}
                  onReturn={() => void run(async () => {
                    setPrompt(prepared.prompt);
                    await client.dispatch('ai.context.discard', { preparationId: prepared.id });
                    setPrepared(undefined);
                    requestAnimationFrame(() => textareaRef.current?.focus());
                  })}
                />
              )}

              {sessionProposals.map((proposal) => {
                const proposalOutputMode: AIWritebackMode = outputProposalId === proposal.id ? outputMode : 'replace';
                const proposalOutputNodeId = outputProposalId === proposal.id
                  ? outputNodeId
                  : (proposal.suggestedTarget?.nodeId ?? '');
                return (
                  <AIWritebackReview
                    key={proposal.id}
                    proposal={proposal}
                    sources={catalog.sources}
                    mode={proposalOutputMode}
                    nodeId={proposalOutputNodeId}
                    onSelectionChange={(mode, nodeId) => {
                      setOutputProposalId(proposal.id);
                      setOutputMode(mode);
                      setOutputNodeId(nodeId);
                    }}
                    onAccept={() => void run(async () => {
                      const target = resolveAIWritebackTarget(
                        proposal,
                        catalog.sources,
                        proposalOutputMode,
                        proposalOutputNodeId,
                      );
                      if (!target) throw new Error('写回目标节点已经不存在');
                      await client.dispatch('ai.proposal.accept', { proposalId: proposal.id, target });
                      setOutputProposalId('');
                      setOutputNodeId('');
                    })}
                    onDismiss={() => void run(() => client.dispatch(
                      'ai.proposal.dismiss',
                      { proposalId: proposal.id },
                    ))}
                  />
                );
              })}
            </>
          )}
          </div>
          <AIChatScrollbar feedId={`ai-chat-feed-${assistantId}`} feedRef={feedRef} />
        </div>

        {memorySuggestion && dismissedMemorySuggestion !== memorySuggestion.id && (
          <AIMemorySuggestionNotice
            suggestion={memorySuggestion}
            onApply={() => {
              setPrompt(`${prompt.trimEnd()}\n${memorySuggestion.directive}`);
              setDismissedMemorySuggestion(memorySuggestion.id);
            }}
            onDismiss={() => setDismissedMemorySuggestion(memorySuggestion.id)}
          />
        )}

        <AIComposer {...composerProps} />
      </section> : state.view === 'memory' ? (
        <AIMemoryCenter
          client={client}
          catalog={memoryCatalog}
          assistantId={assistantId}
          selectedSourceIds={new Set(assistantInstance?.memorySourceIds ?? [])}
          contextMode={assistantInstance?.contextMode ?? 'automatic'}
          memoryCandidates={state.memoryCandidates}
          currentSessionId={activeSession?.id}
          currentSessionTurns={activeSessionTurns}
          memoryFiles={state.memoryFiles}
          status={status}
          onSaveSession={() => void saveCurrentSession()}
          onCorrectMemory={(directive) => {
            setPrompt(directive);
            void client.dispatch('ai.setView', { assistantId, view: 'chat' });
          }}
          error={error}
          onError={setError}
        />
      ) : state.view === 'prompt' ? (
        <AIPromptTemplateCenter
          key={`${assistantInstance?.promptTemplateId ?? 'default'}:${promptCatalog.templates.find((template) => template.id === assistantInstance?.promptTemplateId)?.updatedAt ?? 0}`}
          client={client}
          catalog={promptCatalog}
          assistantId={assistantId}
          selectedTemplateId={assistantInstance?.promptTemplateId}
        />
      ) : (
        <section className="ai-provider-settings-host" aria-label="AI 模型与连接">
          {renderSlot?.('ai.settings')}
          <section className="ai-provider-retrieval-module" aria-label="检索方式">
            {renderSlot?.('ai.retrieval')}
          </section>
          <p className="ai-provider-settings-unavailable">模型连接插件当前不可用。</p>
        </section>
      )}
    </FloatingPanel>
  );
}

function errorMessage(reason: unknown): string {
  return reason instanceof Error ? reason.message : String(reason);
}
