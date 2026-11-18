'use client';

import type { ViewClient } from '../../core/contracts.ts';
import type {
  CommandArguments,
  KnownCommandType,
} from '../../protocols/commands.ts';
import { IconButton } from '../../ui/Icon.tsx';
import type { AIAssistantView } from './types.ts';

export function AIAssistantWindowActions({
  client,
  assistantId,
  view,
  onError,
}: {
  client: ViewClient;
  assistantId: string;
  view: AIAssistantView;
  onError: (message: string) => void;
}) {
  const dispatch = async <TType extends KnownCommandType,>(
    type: TType,
    ...args: CommandArguments<TType>
  ) => {
    onError('');
    try {
      await client.dispatch(type, ...args);
    } catch (reason) {
      onError(errorMessage(reason));
    }
  };
  return <>
    <IconButton
      icon="add"
      label="新开独立 AI 助手"
      onClick={() => void dispatch('ai.assistant.openNew')}
    />
    <IconButton
      icon="sparkles"
      label="AI 对话"
      className={`icon-button${view === 'chat' ? ' is-active' : ''}`}
      onClick={() => void dispatch('ai.setView', { assistantId, view: 'chat' })}
    />
  </>;
}

function errorMessage(reason: unknown): string {
  return reason instanceof Error ? reason.message : String(reason);
}
