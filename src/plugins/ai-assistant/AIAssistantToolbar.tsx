'use client';

import { useEffect, useState, useSyncExternalStore } from 'react';
import type { ViewClient } from '../../core/contracts.ts';
import { IconButton } from '../../ui/Icon.tsx';
import { ToolbarDropdown } from '../../ui/ToolbarDropdown.tsx';
import { useCommandTooltip } from '../../ui/runtime-hooks.ts';
import { AI_UI_NAMESPACE } from './model.ts';
import type { AIAssistantState } from './types.ts';

export function AIAssistantToolbar({ client }: { client: ViewClient }) {
  const version = useSyncExternalStore(client.subscribeState, () => client.getOwnStateVersion(AI_UI_NAMESPACE), () => 0);
  const [state, setState] = useState<AIAssistantState>();
  const tooltip = useCommandTooltip(client, 'ai.open', '打开 AI 助手');
  useEffect(() => {
    let current = true;
    void client.ask<AIAssistantState>('ai.state').then(next => current && setState(next));
    return () => { current = false; };
  }, [client, version]);
  const sessions = new Map(state?.sessions.map(session => [session.id, session]) ?? []);
  const opened = state?.assistants ?? [];
  return <ToolbarDropdown className="ai-toolbar-launcher" menuClassName="ai-toolbar-menu" label="已打开的 AI 助手" enabled={opened.length > 1} width={248} indicator={false}
    trigger={<IconButton icon="sparkles" label={opened.length > 1 ? `${tooltip}；当前打开 ${opened.length} 个窗口` : tooltip} className="toolbar-icon-button" onClick={() => void client.dispatch('ai.open')} />}
    decoration={opened.length > 1 && <span className="ai-toolbar-count" aria-hidden="true">{opened.length}</span>}>
    {opened.map((assistant, index) => {
      const session = sessions.get(assistant.sessionId);
      const title = session?.title || `AI 助手 ${index + 1}`;
      return <div className="ai-toolbar-menu-row" key={assistant.id}>
        <button type="button" role="menuitem" onClick={() => void client.dispatch('ai.assistant.focus', { assistantId: assistant.id })}>
          <span>{title}</span><small>{assistant.view === 'chat' ? '对话' : assistant.view === 'memory' ? '记忆' : assistant.view === 'prompt' ? 'Prompt' : '模型'}</small>
        </button>
        <IconButton icon="trash" label={`删除${title}及其当前对话`} onClick={() => void client.dispatch('ai.assistant.delete', { assistantId: assistant.id })} />
      </div>;
    })}
  </ToolbarDropdown>;
}
