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
  providerSettingsAvailable,
  onError,
}: {
  client: ViewClient;
  assistantId: string;
  view: AIAssistantView;
  providerSettingsAvailable: boolean;
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
    <IconButton
      icon="at"
      label="AI 记忆中心"
      className={`icon-button${view === 'memory' ? ' is-active' : ''}`}
      onClick={() => void dispatch('ai.setView', { assistantId, view: 'memory' })}
    />
    <IconButton
      icon="template"
      label="Prompt 模板"
      className={`icon-button${view === 'prompt' ? ' is-active' : ''}`}
      onClick={() => void dispatch('ai.setView', { assistantId, view: 'prompt' })}
    />
    <IconButton
      icon="key"
      label="配置模型平台与 KEY"
      disabled={!providerSettingsAvailable}
      className={`icon-button${view === 'provider' ? ' is-active' : ''}`}
      onClick={() => providerSettingsAvailable && void dispatch(
        'ai.setView', { assistantId, view: 'provider' },
      )}
    />
  </>;
}

function errorMessage(reason: unknown): string {
  return reason instanceof Error ? reason.message : String(reason);
}
