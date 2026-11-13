import { isRecord, type PluginContext } from '../../core/contracts.ts';
import type { AIRequestInspectionState, AIRequestSnapshot } from '../../protocols/ai-request-inspection.ts';

export function registerAIRequestInspection(context: PluginContext, component?: unknown): void {
  let view: AIRequestInspectionState | undefined;
  const close = () => {
    view = undefined;
    context.ui.deactivateSurface('overlay.modal', 'ai.request-inspection');
    context.signals.emit('ai.request.inspection.changed@1');
  };
  context.commands.register({ type: 'ai.request.inspect@1',
    validate: (input): input is { sessionId: string; turn: number } => isRecord(input) && typeof input.sessionId === 'string' && input.sessionId.length <= 200 && Number.isSafeInteger(input.turn) && Number(input.turn) > 0,
    handle: async input => {
      let requests: AIRequestSnapshot[] = [], error: string | undefined;
      try { requests = await context.capabilities.request<AIRequestSnapshot[]>('ai.provider.requestTrace@1', { sessionId: input.sessionId, userTurn: input.turn }); }
      catch (reason) { error = reason instanceof Error ? reason.message : String(reason); }
      view = { ...input, requests, ...(error ? { error } : {}) };
      context.ui.activateSurface('overlay.modal', 'ai.request-inspection', 'ai.request.closeInspection@1');
      context.signals.emit('ai.request.inspection.changed@1');
      return {};
    },
  });
  context.commands.register({ type: 'ai.request.closeInspection@1', handle: () => { close(); return {}; } });
  context.queries.register({ type: 'ai.request.inspection@1', handle: () => view && structuredClone(view) });
  context.events.subscribe('document.replaced', close);
  context.ui.contribute({ id: 'ai.request-inspection', slot: 'overlay.modal', kind: 'view', label: '本轮发送内容', component });
}
