import type { AITurnRoute } from './turn-route.ts';

export const LOCAL_CANVAS_CLARIFICATION = '这项画布操作只在本地处理，不会发送给云端模型。请补充明确的对象和改法；画布尚未修改。';
export const LOCAL_CANVAS_CONTENT_TARGET = '请明确要创作的正文和写入目标。对象定位与操作计划只在本地处理，尚未调用云端模型。';

/** A model may supply requested prose, never resolve objects or decide canvas actions. */
export function requestsCanvasTextGeneration(route: AITurnRoute): boolean {
  return route.local?.kind === 'content' || route.fieldTask?.kind === 'complete' ||
    Boolean(route.restructureTask || route.creationText) || route.category === 'mixed';
}
