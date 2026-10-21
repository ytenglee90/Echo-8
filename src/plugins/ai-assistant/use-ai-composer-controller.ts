'use client';

import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type PointerEvent as ReactPointerEvent,
} from 'react';
import type { ViewClient } from '../../core/contracts.ts';
import type {
  AIInlineReference,
  AIPreparedContext,
  AISessionRecord,
  AIStatusSignal,
} from '../../protocols/ai.ts';
import { useLocalTextHistory } from '../../ui/use-local-text-history.ts';
import type { AIComposerProps } from './AIComposer.tsx';
import {
  activeInlineReferences,
  atQueryAt,
  compactReferenceToken,
  inferAtOperation,
  replaceAtQuery,
} from './command-parser.ts';
import { buildAIMentionSuggestions } from './mention-suggestions.ts';
import {
  AI_COMPOSER_HEIGHT_MAX,
  normalizeAIComposerHeight,
  type AIAssistantInstanceState,
  type AICatalogSnapshot,
} from './types.ts';

export function useAIComposerController({
  client,
  assistantId,
  assistant,
  activeSession,
  catalog,
  selectedProviderId,
  selectedProviderConfigured,
  status,
  panelHeight,
  stableHeight,
  previewHeight,
  dropReady,
  setPrepared,
  onSubmitted,
  onError,
}: {
  client: ViewClient;
  assistantId: string;
  assistant?: AIAssistantInstanceState;
  activeSession?: AISessionRecord;
  catalog: AICatalogSnapshot;
  selectedProviderId: string;
  selectedProviderConfigured: boolean;
  status: AIStatusSignal['state'];
  panelHeight: number;
  stableHeight: number;
  previewHeight?: number;
  dropReady: boolean;
  setPrepared: (prepared: AIPreparedContext | undefined) => void;
  onSubmitted: () => void;
  onError: (message: string) => void;
}) {
  const [prompt, setPrompt] = useState('');
  const promptHistory = useLocalTextHistory(prompt, setPrompt);
  const {
    change: changePrompt,
    startComposition: startPromptComposition,
    endComposition: endPromptComposition,
    cancelComposition: cancelPromptComposition,
    reset: resetPrompt,
    handleKeyDown: handlePromptHistoryKeyDown,
  } = promptHistory;
  const [inlineReferences, setInlineReferences] = useState<AIInlineReference[]>([]);
  const [caret, setCaret] = useState(0);
  const [activeMentionIndex, setActiveMentionIndex] = useState(0);
  const [dismissedMentionKey, setDismissedMentionKey] = useState('');
  const [composing, setComposing] = useState(false);
  const composingRef = useRef(false);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const draftRestoredRef = useRef(false);
  const resizeRef = useRef<{
    pointerId: number;
    startY: number;
    startHeight: number;
    height: number;
    panelHeight: number;
  } | undefined>(undefined);

  const mentionMenuId = `ai-mention-menu-${assistantId}`;
  const mentionQuery = useMemo(() => atQueryAt(prompt, caret), [caret, prompt]);
  const mentionSuggestions = useMemo(
    () => mentionQuery ? buildAIMentionSuggestions(mentionQuery.query, catalog.sources) : [],
    [catalog.sources, mentionQuery],
  );
  const mentionKey = mentionQuery ? `${mentionQuery.start}:${mentionQuery.end}:${mentionQuery.query}` : '';
  const mentionMenuOpen = !composing && Boolean(mentionQuery && dismissedMentionKey !== mentionKey);
  const resolvedMentionIndex = mentionSuggestions.length === 0
    ? 0
    : Math.min(activeMentionIndex, mentionSuggestions.length - 1);
  const composerHeight = previewHeight ?? stableHeight;
  const composerMaximum = normalizeAIComposerHeight(AI_COMPOSER_HEIGHT_MAX, panelHeight);

  useEffect(() => {
    if (!assistant || draftRestoredRef.current) return;
    draftRestoredRef.current = true;
    const draft = assistant.draft ?? '';
    resetPrompt(draft);
    setCaret(draft.length);
  }, [assistant, resetPrompt]);

  const run = useCallback(async (operation: () => Promise<unknown>) => {
    onError('');
    try {
      await operation();
    } catch (reason) {
      onError(errorMessage(reason));
    }
  }, [onError]);

  const applyPromptInsertion = useCallback((token: string, replaceQuery = true) => {
    const input = textareaRef.current;
    setPrepared(undefined);
    const query = replaceQuery ? atQueryAt(prompt, input?.selectionStart ?? caret) : undefined;
    if (query) {
      const next = replaceAtQuery(prompt, query, token);
      changePrompt(next.text);
      requestAnimationFrame(() => {
        textareaRef.current?.focus();
        textareaRef.current?.setSelectionRange(next.caret, next.caret);
        setCaret(next.caret);
      });
      return;
    }
    const start = input?.selectionStart ?? prompt.length;
    const end = input?.selectionEnd ?? start;
    const prefix = start > 0 && !/\s/u.test(prompt[start - 1]) ? ' ' : '';
    const suffix = end < prompt.length && !/\s/u.test(prompt[end]) ? ' ' : '';
    const insertion = `${prefix}${token} ${suffix}`;
    const nextCaret = start + insertion.length - suffix.length;
    changePrompt(`${prompt.slice(0, start)}${insertion}${prompt.slice(end)}`);
    requestAnimationFrame(() => {
      textareaRef.current?.focus();
      textareaRef.current?.setSelectionRange(nextCaret, nextCaret);
      setCaret(nextCaret);
    });
  }, [caret, changePrompt, prompt, setPrepared]);

  const insertSourceReference = useCallback((sourceId: string, replaceQuery = false) => {
    if (!activeSession) return;
    const source = catalog.sources.find((candidate) => candidate.sourceId === sourceId);
    if (!source) return;
    const duplicateTitle = catalog.sources.some((candidate) =>
      candidate.sourceId !== source.sourceId && candidate.title === source.title);
    const token = compactReferenceToken(source.title, source.sourceId, duplicateTitle);
    setInlineReferences((current) => [
      ...current.filter((reference) => reference.sourceId !== source.sourceId),
      { token, sourceId: source.sourceId },
    ]);
    applyPromptInsertion(token, replaceQuery);
  }, [activeSession, applyPromptInsertion, catalog.sources]);

  const chooseMentionSuggestion = useCallback((suggestion: (typeof mentionSuggestions)[number]) => {
    if (suggestion.kind === 'source') insertSourceReference(suggestion.sourceId, true);
    else applyPromptInsertion(suggestion.token);
    setDismissedMentionKey('');
  }, [applyPromptInsertion, insertSourceReference]);

  const submit = useCallback(async () => {
    if (status === 'indexing') {
      onError('当前对话正在保存并建立索引，请稍候');
      return;
    }
    await run(async () => {
      if (!activeSession) throw new Error('当前对话仍在初始化，请稍候');
      if (!prompt.trim()) throw new Error('请输入要求');
      if (!selectedProviderConfigured) throw new Error('当前助手的模型连接尚未配置，请点击 KEY 按钮完成配置');
      setPrepared(undefined);
      onSubmitted();
      await client.dispatch('ai.context.prepare', {
        assistantId,
        sessionId: activeSession.id,
        prompt: prompt.trim(),
        operation: inferAtOperation(prompt),
        providerProfileId: selectedProviderId || undefined,
        webSearchEnabled: assistant?.webSearchEnabled === true,
        promptTemplateId: assistant?.promptTemplateId,
        memorySourceIds: assistant?.memorySourceIds,
        references: activeInlineReferences(prompt, inlineReferences),
        autoStart: true,
      });
      resetPrompt('');
      client.emit('ai.composer.draft.preview', { assistantId, draft: '' });
      setInlineReferences([]);
    });
  }, [
    activeSession,
    assistant,
    assistantId,
    client,
    inlineReferences,
    onError,
    onSubmitted,
    prompt,
    run,
    resetPrompt,
    selectedProviderConfigured,
    selectedProviderId,
    setPrepared,
    status,
  ]);

  const cancelComposition = useCallback(() => {
    const restored = cancelPromptComposition();
    composingRef.current = false;
    setComposing(false);
    if (restored !== undefined) client.emit('ai.composer.draft.preview', { assistantId, draft: restored });
  }, [assistantId, cancelPromptComposition, client]);

  const startResize = useCallback((event: ReactPointerEvent<HTMLDivElement>) => {
    if (event.button !== 0) return;
    event.preventDefault();
    event.currentTarget.setPointerCapture(event.pointerId);
    const measuredPanelHeight = event.currentTarget.closest('.floating-panel')?.getBoundingClientRect().height ?? panelHeight;
    const startHeight = textareaRef.current?.getBoundingClientRect().height ?? composerHeight;
    resizeRef.current = {
      pointerId: event.pointerId,
      startY: event.clientY,
      startHeight,
      height: startHeight,
      panelHeight: measuredPanelHeight,
    };
    client.emit('ai.composer.resize.preview', { assistantId, height: startHeight });
  }, [assistantId, client, composerHeight, panelHeight]);

  const previewResize = useCallback((event: ReactPointerEvent<HTMLDivElement>) => {
    const gesture = resizeRef.current;
    if (!gesture || gesture.pointerId !== event.pointerId) return;
    gesture.height = normalizeAIComposerHeight(
      gesture.startHeight + gesture.startY - event.clientY,
      gesture.panelHeight,
    );
    client.emit('ai.composer.resize.preview', { assistantId, height: gesture.height });
  }, [assistantId, client]);

  const finishResize = useCallback((event: ReactPointerEvent<HTMLDivElement>, commit: boolean) => {
    const gesture = resizeRef.current;
    if (!gesture || gesture.pointerId !== event.pointerId) return;
    resizeRef.current = undefined;
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
    if (commit) {
      void run(() => client.dispatch('ai.setComposerHeight', { assistantId, height: gesture.height }))
        .finally(() => client.emit('ai.composer.resize.preview', { assistantId, clear: true }));
      return;
    }
    client.emit('ai.composer.resize.preview', { assistantId, clear: true });
  }, [assistantId, client, run]);

  const composerProps: AIComposerProps = {
    textareaRef,
    assistantId,
    value: prompt,
    height: composerHeight,
    maximumHeight: composerMaximum,
    disabled: !activeSession,
    dropReady,
    status,
    sendDisabled: !activeSession || !prompt.trim() || status === 'preparing' || status === 'indexing' ||
      !selectedProviderConfigured,
    mentionMenuId,
    mentionMenuOpen,
    mentionSuggestions,
    activeMentionIndex: resolvedMentionIndex,
    onResizePointerDown: startResize,
    onResizePointerMove: previewResize,
    onResizePointerUp: (event) => finishResize(event, true),
    onResizePointerCancel: (event) => finishResize(event, false),
    onResizeKey: (direction, largeStep) => {
      const step = largeStep ? 40 : 12;
      const height = normalizeAIComposerHeight(
        composerHeight + (direction === 'up' ? step : -step),
        panelHeight,
      );
      void run(() => client.dispatch('ai.setComposerHeight', { assistantId, height }));
    },
    onCompositionStart: () => {
      startPromptComposition();
      composingRef.current = true;
      setComposing(true);
      setDismissedMentionKey(mentionKey);
    },
    onCompositionEnd: (event) => {
      const value = event.currentTarget.value;
      composingRef.current = false;
      endPromptComposition(value);
      setComposing(false);
      setCaret(event.currentTarget.selectionStart);
      setActiveMentionIndex(0);
      setDismissedMentionKey('');
      client.emit('ai.composer.draft.preview', { assistantId, draft: value });
    },
    onChange: (event) => {
      setPrepared(undefined);
      changePrompt(event.target.value);
      if (!composingRef.current) client.emit('ai.composer.draft.preview', { assistantId, draft: event.target.value });
      setCaret(event.target.selectionStart);
      setActiveMentionIndex(0);
      setDismissedMentionKey('');
    },
    onCaretChange: (event) => setCaret(event.currentTarget.selectionStart),
    onKeyDown: (event) => {
      if (event.nativeEvent.isComposing) return;
      if (handlePromptHistoryKeyDown(event)) {
        requestAnimationFrame(() => setCaret(textareaRef.current?.selectionStart ?? 0));
        return;
      }
      if (mentionMenuOpen && mentionSuggestions.length > 0 &&
        (event.key === 'ArrowDown' || event.key === 'ArrowUp')) {
        event.preventDefault();
        setActiveMentionIndex((current) => event.key === 'ArrowDown'
          ? (current + 1) % mentionSuggestions.length
          : (current - 1 + mentionSuggestions.length) % mentionSuggestions.length);
        return;
      }
      if (mentionMenuOpen && event.key === 'Escape') {
        event.preventDefault();
        setDismissedMentionKey(mentionKey);
        return;
      }
      if (mentionMenuOpen && event.key === 'Tab' && mentionSuggestions[resolvedMentionIndex]) {
        event.preventDefault();
        chooseMentionSuggestion(mentionSuggestions[resolvedMentionIndex]);
        return;
      }
      if (mentionMenuOpen && event.key === 'Enter' && !event.ctrlKey && !event.metaKey && !event.shiftKey &&
        mentionSuggestions[resolvedMentionIndex]) {
        event.preventDefault();
        chooseMentionSuggestion(mentionSuggestions[resolvedMentionIndex]);
        return;
      }
      if (event.key === 'Enter' && !event.metaKey && !event.ctrlKey && !event.shiftKey) {
        event.preventDefault();
        void submit();
      }
    },
    onSend: () => void submit(),
    onStop: () => void run(() => client.dispatch('ai.generation.cancel', { sessionId: activeSession?.id })),
    onChooseMention: chooseMentionSuggestion,
    onActiveMention: setActiveMentionIndex,
  };

  return {
    prompt,
    setPrompt: changePrompt,
    textareaRef,
    composerHeight,
    composerProps,
    insertSourceReference,
    cancelComposition,
  };
}

function errorMessage(reason: unknown): string {
  return reason instanceof Error ? reason.message : String(reason);
}
