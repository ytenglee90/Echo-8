import type { PatchOperation } from '../../core/contracts.ts';
import type { AIContextMode, AISessionRecord } from '../../protocols/ai.ts';
import { normalizeFloatingRect, type FloatingPanelRect } from '../../protocols/floating.ts';
import { isAssistantInstanceState, readAssistantView } from './command-payloads.ts';
import {
  normalizeAIComposerHeight,
  type AIAssistantInstanceState,
  type AIAssistantView,
} from './types.ts';

export const AI_UI_NAMESPACE = 'aiAssistantUI';
export const DEFAULT_AI_RECT: FloatingPanelRect = { x: 720, y: 76, width: 520, height: 720 };

export interface AssistantSessionSettings {
  providerProfileId?: string;
  webSearchEnabled?: boolean;
  promptTemplateId?: string;
  memorySourceIds?: string[];
  contextMode?: AIContextMode;
  autoMemoryCandidates?: boolean;
}

export interface AssistantWorkspaceSource {
  sessions: Record<string, AISessionRecord>;
  sessionSettings?: Record<string, AssistantSessionSettings>;
  storedAssistants: unknown;
  legacyOpen?: boolean;
  legacySessionId?: string;
  legacyPanelRect?: unknown;
  legacyComposerHeight?: unknown;
  legacyView?: unknown;
}

export interface CreateAssistantInstanceRequest {
  id: string;
  sessionId: string;
  view?: AIAssistantView;
  legacyView?: unknown;
  offset?: number;
  inheritLayout?: boolean;
  panelRect?: unknown;
  composerHeight?: unknown;
  settings?: AssistantSessionSettings;
  createdAt: number;
}

/**
 * Rehydrates personal assistant-window state while discarding windows whose
 * durable sessions no longer exist. The legacy fields are read-only migration
 * inputs and never become an alternate source of document data.
 */
export function readAssistantInstancesFromWorkspace(
  source: AssistantWorkspaceSource,
): AIAssistantInstanceState[] {
  const settingsBySession = source.sessionSettings ?? {};
  if (Array.isArray(source.storedAssistants)) {
    return source.storedAssistants
      .filter(isAssistantInstanceState)
      .filter((assistant) => Boolean(source.sessions[assistant.sessionId]))
      .map((assistant) => {
        const settings = settingsBySession[assistant.sessionId] ?? {};
        return {
          ...assistant,
          rect: normalizeFloatingRect(assistant.rect, DEFAULT_AI_RECT),
          composerHeight: normalizeAIComposerHeight(assistant.composerHeight, assistant.rect.height),
          view: readAssistantView(assistant.view),
          minimized: assistant.minimized === true,
          providerProfileId: assistant.providerProfileId ?? settings.providerProfileId,
          webSearchEnabled: assistant.webSearchEnabled ?? settings.webSearchEnabled,
          promptTemplateId: assistant.promptTemplateId ?? settings.promptTemplateId,
          memorySourceIds: assistant.memorySourceIds ?? settings.memorySourceIds,
          contextMode: assistant.contextMode ?? settings.contextMode,
          autoMemoryCandidates: assistant.autoMemoryCandidates ?? settings.autoMemoryCandidates,
        };
      });
  }

  const sessionId = source.legacySessionId;
  if (!source.legacyOpen || !sessionId || !source.sessions[sessionId]) return [];
  const rect = normalizeFloatingRect(source.legacyPanelRect, DEFAULT_AI_RECT);
  return [{
    id: 'ai-assistant-primary',
    sessionId,
    rect,
    composerHeight: normalizeAIComposerHeight(source.legacyComposerHeight, rect.height),
    view: readAssistantView(source.legacyView),
    createdAt: source.sessions[sessionId].createdAt,
  }];
}

export function selectPrimaryAssistant(
  assistants: AIAssistantInstanceState[],
  activeAssistantId?: string,
): AIAssistantInstanceState | undefined {
  return assistants.find((assistant) => assistant.id === activeAssistantId) ??
    assistants.find((assistant) => assistant.minimized !== true) ??
    assistants[0];
}

export function buildAssistantWorkspacePatches(
  assistants: AIAssistantInstanceState[],
  activeAssistantId: string | undefined,
  sessions: Record<string, AISessionRecord>,
  previousSettings: Record<string, AssistantSessionSettings> = {},
): PatchOperation[] {
  const visible = assistants.filter((assistant) => assistant.minimized !== true);
  const primary = selectPrimaryAssistant(assistants, activeAssistantId);
  const sessionSettings: Record<string, AssistantSessionSettings> = Object.fromEntries(
    Object.entries(previousSettings).filter(([sessionId]) => Boolean(sessions[sessionId])),
  );
  for (const assistant of assistants) {
    sessionSettings[assistant.sessionId] = {
      ...(assistant.providerProfileId ? { providerProfileId: assistant.providerProfileId } : {}),
      ...(assistant.webSearchEnabled ? { webSearchEnabled: true } : {}),
      ...(assistant.promptTemplateId ? { promptTemplateId: assistant.promptTemplateId } : {}),
      ...(assistant.memorySourceIds?.length ? { memorySourceIds: assistant.memorySourceIds } : {}),
      ...(assistant.contextMode === 'explicit-only' ? { contextMode: assistant.contextMode } : {}),
      ...(assistant.autoMemoryCandidates ? { autoMemoryCandidates: true } : {}),
    };
  }
  return [
    { op: 'set', domain: 'workspace', namespace: AI_UI_NAMESPACE, key: 'assistants', value: assistants },
    { op: 'set', domain: 'workspace', namespace: AI_UI_NAMESPACE, key: 'sessionSettings', value: sessionSettings },
    { op: 'set', domain: 'workspace', namespace: AI_UI_NAMESPACE, key: 'open', value: visible.length > 0 },
    ...(primary ? [
      { op: 'set' as const, domain: 'workspace' as const, namespace: AI_UI_NAMESPACE, key: 'panelRect', value: primary.rect },
      { op: 'set' as const, domain: 'workspace' as const, namespace: AI_UI_NAMESPACE, key: 'composerHeight', value: primary.composerHeight },
      { op: 'set' as const, domain: 'workspace' as const, namespace: AI_UI_NAMESPACE, key: 'view', value: primary.view },
      { op: 'set' as const, domain: 'workspace' as const, namespace: AI_UI_NAMESPACE, key: 'activeSessionId', value: primary.sessionId },
    ] : []),
  ];
}

export function createAssistantSession(ordinal: number, id: string, now: number): AISessionRecord {
  return {
    id,
    title: ordinal <= 1 ? 'AI 当前对话' : `AI 对话 ${ordinal}`,
    transcriptRevision: 0,
    transcriptLength: 0,
    transcriptEntries: 0,
    revision: 1,
    turns: 0,
    createdAt: now,
    updatedAt: now,
  };
}

export function createAssistantInstance(
  request: CreateAssistantInstanceRequest,
): AIAssistantInstanceState {
  const inheritLayout = request.inheritLayout !== false;
  const baseRect = inheritLayout
    ? normalizeFloatingRect(request.panelRect, DEFAULT_AI_RECT)
    : DEFAULT_AI_RECT;
  const offset = request.offset ?? 0;
  const rect = normalizeFloatingRect({
    ...baseRect,
    x: baseRect.x + offset * 28,
    y: baseRect.y + offset * 24,
  }, DEFAULT_AI_RECT);
  return {
    id: request.id,
    sessionId: request.sessionId,
    rect,
    composerHeight: normalizeAIComposerHeight(
      inheritLayout ? request.composerHeight : undefined,
      rect.height,
    ),
    view: request.view ?? (inheritLayout ? readAssistantView(request.legacyView) : 'chat'),
    minimized: false,
    ...request.settings,
    createdAt: request.createdAt,
  };
}
