import type { AITurnRoute } from './turn-route.ts';

/** Parsed text tasks bind sources and destinations locally before requesting prose. */
export function requestsCanvasTextGeneration(route: AITurnRoute): boolean {
  return route.local?.kind === 'content' || route.fieldTask?.kind === 'complete' || route.fieldTask?.kind === 'change' && !route.fieldTask.value ||
    Boolean(route.restructureTask || route.creationText || route.textComposition || route.compositionCandidate) || route.category === 'mixed';
}
