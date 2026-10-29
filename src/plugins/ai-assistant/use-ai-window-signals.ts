'use client';

import { useCallback, useEffect, useRef, useState, type RefObject } from 'react';
import type { MessageEnvelope, ViewClient } from '../../core/contracts.ts';
import type {
  AIGenerationDeltaSignal,
  AIPreparedContext,
  AIStatusSignal,
} from '../../protocols/ai.ts';
import type {
  ContentReferenceDragPreview,
  ContentReferenceDrop,
} from '../../protocols/content.ts';
import type { AIAssistantState } from './types.ts';
import {
  applyAIStreamingDeltaBatch,
  type AIStreamingResponseState,
} from './streaming-delta-batch.ts';

export type { AIStreamingResponseState } from './streaming-delta-batch.ts';

type GenerationRuntime = AIAssistantState['generationRuntimeBySession'][string];

export function useAIWindowSignals({
  client,
  assistantId,
  activeSessionIdRef,
  transcriptNodeIdRef,
  dropOwner,
  onReferenceDrop,
}: {
  client: ViewClient;
  assistantId: string;
  activeSessionIdRef: RefObject<string | undefined>;
  transcriptNodeIdRef: RefObject<string | undefined>;
  dropOwner: string;
  onReferenceDrop: (sourceIds: readonly string[]) => void;
}) {
  const [prepared, setPrepared] = useState<AIPreparedContext>();
  const [status, setStatus] = useState<AIStatusSignal>({ state: 'idle', message: '输入要求后发送' });
  const [streamingResponse, setStreamingResponse] = useState<AIStreamingResponseState>();
  const [stateVersion, setStateVersion] = useState(0);
  const [catalogVersion, setCatalogVersion] = useState(0);
  const [transcriptVersion, setTranscriptVersion] = useState(0);
  const [providerVersion, setProviderVersion] = useState(0);
  const [memoryVersion, setMemoryVersion] = useState(0);
  const [referenceDropReady, setReferenceDropReady] = useState(false);
  const [composerPreviewHeight, setComposerPreviewHeight] = useState<number>();
  const [focusToken, setFocusToken] = useState(0);
  const referenceDropRef = useRef(onReferenceDrop);

  useEffect(() => {
    referenceDropRef.current = onReferenceDrop;
  }, [onReferenceDrop]);

  const restoreGenerationRuntime = useCallback((runtime?: GenerationRuntime, sessionId?: string) => {
    if (!runtime) return;
    setStatus({
      state: runtime.state,
      message: runtime.message,
      sessionId,
      ...(runtime.preparationId ? { preparationId: runtime.preparationId } : {}),
    });
    if (runtime.state === 'generating' && runtime.preparationId) {
      setPrepared(undefined);
      setStreamingResponse({
        preparationId: runtime.preparationId,
        sequence: runtime.sequence,
        text: runtime.text,
        reasoning: runtime.reasoning,
      });
    }
  }, []);

  useEffect(() => {
    const pendingDeltas: AIGenerationDeltaSignal[] = [];
    let pendingFlush: { kind: 'frame' | 'timer'; id: number } | undefined;
    const cancelPendingDeltas = () => {
      if (pendingFlush?.kind === 'frame') globalThis.cancelAnimationFrame?.(pendingFlush.id);
      else if (pendingFlush?.kind === 'timer') globalThis.clearTimeout(pendingFlush.id);
      pendingFlush = undefined;
      pendingDeltas.length = 0;
    };
    const flushDeltas = () => {
      pendingFlush = undefined;
      if (pendingDeltas.length === 0) return;
      const batch = pendingDeltas.splice(0, pendingDeltas.length);
      setStreamingResponse((current) => applyAIStreamingDeltaBatch(
        current,
        batch,
        activeSessionIdRef.current,
      ));
    };
    const scheduleDeltaFlush = () => {
      if (pendingFlush) return;
      if (typeof globalThis.requestAnimationFrame === 'function') {
        pendingFlush = { kind: 'frame', id: globalThis.requestAnimationFrame(flushDeltas) };
      } else {
        pendingFlush = { kind: 'timer', id: globalThis.setTimeout(flushDeltas, 16) as unknown as number };
      }
    };
    const removeStatus = client.subscribeSignal<AIStatusSignal>(
      'ai.status',
      (message: MessageEnvelope<AIStatusSignal>) => {
        const activeSessionId = activeSessionIdRef.current;
        if (message.payload.sessionId && message.payload.sessionId !== activeSessionId) return;
        setStatus(message.payload);
        if (message.payload.state === 'generating' && message.payload.preparationId) {
          cancelPendingDeltas();
          setPrepared(undefined);
          setStreamingResponse({ preparationId: message.payload.preparationId, sequence: 0, text: '', reasoning: '' });
        } else if (message.payload.state === 'complete' || message.payload.state === 'idle') {
          cancelPendingDeltas();
          setStreamingResponse(undefined);
        }
      },
    );
    const removeGenerationDelta = client.subscribeSignal<AIGenerationDeltaSignal>(
      'ai.generation.delta',
      (message) => {
        if (message.payload.sessionId !== activeSessionIdRef.current) return;
        pendingDeltas.push(message.payload);
        scheduleDeltaFlush();
      },
    );
    const removeContext = client.subscribeSignal<AIPreparedContext>(
      'ai.context.ready',
      (message: MessageEnvelope<AIPreparedContext>) => {
        if (message.payload.sessionId === activeSessionIdRef.current) setPrepared(message.payload);
      },
    );
    const removeState = client.subscribeSignal('ai.state.invalidated', () =>
      setStateVersion((version) => version + 1));
    const removeCatalog = client.subscribeSignal('ai.catalog.invalidated', () =>
      setCatalogVersion((version) => version + 1));
    const removeTranscript = client.subscribeSignal<{ nodeId?: string }>('ai.transcript.invalidated', (message) => {
      if (!message.payload.nodeId || message.payload.nodeId === transcriptNodeIdRef.current) {
        setTranscriptVersion((version) => version + 1);
      }
    });
    const removeProvider = client.subscribeSignal('ai.provider.changed', () =>
      setProviderVersion((version) => version + 1));
    const removeMemory = client.subscribeSignal('ai.memory.invalidated', () =>
      setMemoryVersion((version) => version + 1));
    const removeReferencePreview = client.subscribeSignal<ContentReferenceDragPreview>(
      'content.reference.drag.preview',
      (message) => setReferenceDropReady(Boolean(
        !message.payload.clear && message.payload.overTarget && message.payload.targetOwner === dropOwner,
      )),
    );
    const removeReferenceDrop = client.subscribeSignal<ContentReferenceDrop>(
      'content.reference.drop',
      (message) => {
        if (message.payload.targetOwner !== dropOwner) return;
        setReferenceDropReady(false);
        referenceDropRef.current([...new Set([
          message.payload.sourceId,
          ...(message.payload.sourceIds ?? []),
        ].filter(Boolean))]);
      },
    );
    const removeComposerResize = client.subscribeSignal<{ assistantId?: string; height?: number; clear?: boolean }>(
      'ai.composer.resize.preview',
      (message) => {
        if (message.payload.assistantId !== assistantId) return;
        setComposerPreviewHeight(message.payload.clear ? undefined : message.payload.height);
      },
    );
    const removeFocusRequest = client.subscribeSignal<{ assistantId: string }>(
      'ai.assistant.focus.requested',
      (message) => {
        if (message.payload.assistantId === assistantId) setFocusToken((value) => value + 1);
      },
    );
    return () => {
      cancelPendingDeltas();
      removeStatus();
      removeGenerationDelta();
      removeContext();
      removeState();
      removeCatalog();
      removeTranscript();
      removeProvider();
      removeMemory();
      removeReferencePreview();
      removeReferenceDrop();
      removeComposerResize();
      removeFocusRequest();
    };
  }, [activeSessionIdRef, assistantId, client, dropOwner, transcriptNodeIdRef]);

  return {
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
  };
}
