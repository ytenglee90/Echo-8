import type { AIGenerationDeltaSignal } from '../../protocols/ai.ts';

export interface AIStreamingResponseState {
  preparationId: string;
  sequence: number;
  text: string;
  reasoning: string;
}

/**
 * Applies one visual frame of ordered stream deltas with at most one string
 * concatenation per channel. The transcript remains authoritative; this state
 * is an ephemeral projection only.
 */
export function applyAIStreamingDeltaBatch(
  current: AIStreamingResponseState | undefined,
  deltas: readonly AIGenerationDeltaSignal[],
  activeSessionId: string | undefined,
): AIStreamingResponseState | undefined {
  if (!activeSessionId || deltas.length === 0) return current;
  let preparationId = current?.preparationId;
  let sequence = current?.sequence ?? 0;
  let baseText = current?.text ?? '';
  let baseReasoning = current?.reasoning ?? '';
  let answerParts: string[] = [];
  let reasoningParts: string[] = [];
  let changed = false;

  for (const delta of deltas) {
    if (delta.sessionId !== activeSessionId || !delta.delta) continue;
    if (preparationId !== delta.preparationId) {
      preparationId = delta.preparationId;
      sequence = 0;
      baseText = '';
      baseReasoning = '';
      answerParts = [];
      reasoningParts = [];
      changed = false;
    }
    if (delta.sequence <= sequence) continue;
    sequence = delta.sequence;
    if (delta.channel === 'reasoning') reasoningParts.push(delta.delta);
    else answerParts.push(delta.delta);
    changed = true;
  }

  if (!changed || !preparationId) return current;
  return {
    preparationId,
    sequence,
    text: answerParts.length > 0 ? baseText + answerParts.join('') : baseText,
    reasoning: reasoningParts.length > 0 ? baseReasoning + reasoningParts.join('') : baseReasoning,
  };
}
