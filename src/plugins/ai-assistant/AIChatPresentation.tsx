import { Icon } from '../../ui/Icon.tsx';
import { AI_OPERATION_COMMANDS } from './command-parser.ts';
import { AI_MEMORY_DIRECTIVE_COMMANDS } from './memory-protocol.ts';
import { memoryDirectiveLabel, type MemorySuggestion } from './memory-suggestion.ts';

const AI_COMMAND_HINT_GROUPS = [
  ...Array.from(new Set(AI_OPERATION_COMMANDS.map((command) => command.category))).map((category) => ({
    category,
    commands: AI_OPERATION_COMMANDS.filter((command) => command.category === category)
      .map((command) => `@${command.label}`),
  })),
  { category: '记忆管理', commands: AI_MEMORY_DIRECTIVE_COMMANDS.map((command) => command.token) },
];

export function AIChatEmptyState() {
  return (
    <div className="ai-empty-state">
      <Icon name="sparkles" size={24} />
      <strong>正在准备当前对话</strong>
      <span>聊天原文会持续记录；保存后进入 AI 记忆中心，不占用画布。</span>
    </div>
  );
}

export function AICommandHints() {
  return (
    <details className="ai-command-hints" aria-label="可用的 @ 指令提示">
      <summary><strong>@ 指令与画布引用</strong><span>输入 @ 即可检索</span></summary>
      <div>
        {AI_COMMAND_HINT_GROUPS.map((group) => (
          <p key={group.category}>
            <b>{group.category}</b>
            <span>{group.commands.join('　')}</span>
          </p>
        ))}
      </div>
    </details>
  );
}

export function AIStreamingResponse({ text, reasoning }: { text: string; reasoning: string }) {
  return (
    <article className="ai-streaming-response ai-chat-bubble assistant" aria-label="AI 正在流式生成" aria-live="polite">
      <header><strong>正在生成</strong><span>{text.length.toLocaleString()} 字符</span></header>
      {reasoning && <details className="ai-reasoning-block">
        <summary>思考过程</summary>
        <p>{reasoning}</p>
      </details>}
      <p>{text}<i aria-hidden="true" /></p>
    </article>
  );
}

export function AIGenerationFollowupButton({
  kind,
  disabled,
  onClick,
}: {
  kind: 'retry' | 'repeat';
  disabled?: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      className="ai-generation-followup"
      disabled={disabled}
      title={kind === 'retry' ? '重新发送上一次失败的内容' : '针对上一个问题重新生成一份回答'}
      aria-label={kind === 'retry' ? '重试上一次发送' : '针对上一个问题再来一次'}
      onClick={onClick}
    ><Icon name={kind === 'retry' ? 'reset' : 'sparkles'} size={15} /></button>
  );
}

export function AIMemorySuggestionNotice({
  suggestion,
  onApply,
  onDismiss,
}: {
  suggestion: MemorySuggestion;
  onApply: () => void;
  onDismiss: () => void;
}) {
  return (
    <aside className="ai-memory-suggestion" aria-label="可能的重要信息">
      <span><strong>可能是需要定状态的信息</strong><small>{suggestion.explanation}</small></span>
      <button type="button" onClick={onApply}>加入“{memoryDirectiveLabel(suggestion.kind)}”</button>
      <button type="button" onClick={onDismiss}>忽略</button>
    </aside>
  );
}
