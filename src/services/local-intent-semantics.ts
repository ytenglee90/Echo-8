import { LOCAL_INTENT_HEADS } from './local-intent-heads.generated.ts';

export type LocalIntentKind = typeof LOCAL_INTENT_HEADS.small.kinds[number];

export interface LocalIntentScore { kind: LocalIntentKind; score: number; margin: number }

export function predictLocalIntent(query: Float32Array, modelId: 'small' | 'base' = 'small'): LocalIntentScore {
  const head = LOCAL_INTENT_HEADS[modelId];
  if (query.length !== head.dimensions || query.some(value => !Number.isFinite(value))) throw new Error('本地意图向量无效');
  const ranked = head.kinds.map((kind, index) => {
    const weights = head.weights[index]!;
    let score: number = weights[head.dimensions]!;
    for (let dimension = 0; dimension < query.length; dimension++) score += query[dimension]! * weights[dimension]!;
    return { kind: kind as LocalIntentKind, score };
  }).sort((left, right) => right.score - left.score);
  return { ...ranked[0]!, margin: ranked[0]!.score - ranked[1]!.score };
}
