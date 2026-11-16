import { isRecord } from '../core/contracts.ts';

export const ASSISTANT_PREFERENCE_ACTIONS = ['group', 'horizontal', 'vertical'] as const;
export type AssistantPreferenceAction = typeof ASSISTANT_PREFERENCE_ACTIONS[number];
interface PreferenceBase { id: string; enabled: boolean; bookId?: string; origin?: 'manual' | 'explicit' | 'feedback' }
export type AssistantPreferenceEntry = PreferenceBase & (
  | { kind: 'phrase'; phrase: string; action: AssistantPreferenceAction; status: 'active' | 'candidate'; evidence: number }
  | { kind: 'gap'; gap: number }
);
export interface AssistantPreferences {
  schemaVersion: 1;
  enabled: boolean;
  learning: boolean;
  entries: AssistantPreferenceEntry[];
}
export interface AssistantPreferenceAccount { userId: string; installationId?: string; bookId?: string; available: boolean }
export interface AssistantPreferenceSnapshot { revision: number; preferences: AssistantPreferences }
export interface AssistantPreferenceState {
  account?: AssistantPreferenceAccount;
  snapshot?: AssistantPreferenceSnapshot;
  busy: boolean;
  error?: string;
}

export const emptyAssistantPreferences = (): AssistantPreferences => ({ schemaVersion: 1, enabled: true, learning: false, entries: [] });
export const preferencePhrase = (phrase: string) => phrase.normalize('NFKC').trim().replace(/[。！!]+$/gu, '').toLocaleLowerCase('zh-CN');

export function isAssistantPreferences(value: unknown): value is AssistantPreferences {
  if (!isRecord(value) || value.schemaVersion !== 1 || typeof value.enabled !== 'boolean' || typeof value.learning !== 'boolean' ||
    !Array.isArray(value.entries) || value.entries.length > 300) return false;
  const ids = new Set<string>();
  const keys = new Set<string>();
  for (const entry of value.entries) {
    if (!isRecord(entry) || typeof entry.id !== 'string' || !entry.id || entry.id.length > 120 || ids.has(entry.id) ||
      typeof entry.enabled !== 'boolean' || entry.bookId !== undefined && (typeof entry.bookId !== 'string' || !entry.bookId || entry.bookId.length > 200) ||
      entry.origin !== undefined && !['manual', 'explicit', 'feedback'].includes(String(entry.origin))) return false;
    ids.add(entry.id);
    const scope = entry.bookId ?? '';
    let key: string;
    if (entry.kind === 'phrase' && typeof entry.phrase === 'string' && preferencePhrase(entry.phrase) && entry.phrase.length <= 80 &&
      !/[\r\n]/u.test(entry.phrase) && ASSISTANT_PREFERENCE_ACTIONS.includes(entry.action as AssistantPreferenceAction) &&
      (entry.status === 'active' || entry.status === 'candidate') && typeof entry.evidence === 'number' &&
      Number.isInteger(entry.evidence) && entry.evidence >= 1 && entry.evidence <= 100) {
      if (Object.keys(entry).some(field => !['id', 'enabled', 'bookId', 'origin', 'kind', 'phrase', 'action', 'status', 'evidence'].includes(field))) return false;
      key = JSON.stringify([scope, entry.kind, preferencePhrase(entry.phrase), entry.status]);
    } else if (entry.kind === 'gap' && typeof entry.gap === 'number' && Number.isInteger(entry.gap) && entry.gap >= 0 && entry.gap <= 2_000) {
      if (Object.keys(entry).some(field => !['id', 'enabled', 'bookId', 'origin', 'kind', 'gap'].includes(field))) return false;
      key = JSON.stringify([scope, entry.kind]);
    } else return false;
    if (keys.has(key)) return false;
    keys.add(key);
  }
  return Object.keys(value).every(key => ['schemaVersion', 'enabled', 'learning', 'entries'].includes(key));
}

declare module './messages.ts' {
  interface ApplicationCapabilityMap {
    'account.assistantPreferences@1': MessageContract<{
      account: AssistantPreferenceAccount;
      write?: { expectedRevision: number; preferences: AssistantPreferences };
    }, AssistantPreferenceSnapshot>;
  }
  interface ApplicationQueryMap {
    'account.assistantPreferenceScope@1': MessageContract<undefined, AssistantPreferenceAccount | undefined>;
    'ai.personal.state@1': MessageContract<undefined, AssistantPreferenceState>;
  }
}
declare module './commands.ts' {
  interface ApplicationCommandMap {
    'ai.personal.open@1': CommandContract;
    'ai.personal.close@1': CommandContract;
    'ai.personal.refresh@1': CommandContract;
    'ai.personal.update@1': CommandContract<{ account: AssistantPreferenceAccount; expectedRevision: number; preferences: AssistantPreferences }>;
    'ai.personal.export@1': CommandContract<{ ids?: string[] }, { text: string }>;
  }
}
