import type {
  ChangeEvent,
  CompositionEvent,
  KeyboardEvent,
  PointerEvent,
  RefObject,
  SyntheticEvent,
} from 'react';
import type { AIStatusSignal } from '../../protocols/ai.ts';
import { Icon, IconButton } from '../../ui/Icon.tsx';
import type { AIMentionSuggestion } from './mention-suggestions.ts';
import { AI_COMPOSER_HEIGHT_MIN } from './types.ts';

export interface AIComposerProps {
  textareaRef: RefObject<HTMLTextAreaElement | null>;
  assistantId: string;
  value: string;
  height: number;
  maximumHeight: number;
  disabled: boolean;
  dropReady: boolean;
  status: AIStatusSignal['state'];
  sendDisabled: boolean;
  mentionMenuId: string;
  mentionMenuOpen: boolean;
  mentionSuggestions: readonly AIMentionSuggestion[];
  activeMentionIndex: number;
  onResizePointerDown: (event: PointerEvent<HTMLDivElement>) => void;
  onResizePointerMove: (event: PointerEvent<HTMLDivElement>) => void;
  onResizePointerUp: (event: PointerEvent<HTMLDivElement>) => void;
  onResizePointerCancel: (event: PointerEvent<HTMLDivElement>) => void;
  onResizeKey: (direction: 'up' | 'down', largeStep: boolean) => void;
  onCompositionStart: () => void;
  onCompositionEnd: (event: CompositionEvent<HTMLTextAreaElement>) => void;
  onChange: (event: ChangeEvent<HTMLTextAreaElement>) => void;
  onCaretChange: (event: SyntheticEvent<HTMLTextAreaElement>) => void;
  onKeyDown: (event: KeyboardEvent<HTMLTextAreaElement>) => void;
  onSend: () => void;
  onStop: () => void;
  onChooseMention: (suggestion: AIMentionSuggestion) => void;
  onActiveMention: (index: number) => void;
}

export function AIComposer({
  textareaRef,
  assistantId,
  value,
  height,
  maximumHeight,
  disabled,
  dropReady,
  status,
  sendDisabled,
  mentionMenuId,
  mentionMenuOpen,
  mentionSuggestions,
  activeMentionIndex,
  onResizePointerDown,
  onResizePointerMove,
  onResizePointerUp,
  onResizePointerCancel,
  onResizeKey,
  onCompositionStart,
  onCompositionEnd,
  onChange,
  onCaretChange,
  onKeyDown,
  onSend,
  onStop,
  onChooseMention,
  onActiveMention,
}: AIComposerProps) {
  const activeSuggestion = mentionSuggestions[activeMentionIndex];
  return (
    <div className={`ai-composer ${dropReady && !disabled ? 'reference-drop-ready' : ''}`}>
      <div
        className="ai-composer-resize-handle"
        role="separator"
        aria-label="调整 AI 输入框高度"
        aria-orientation="horizontal"
        aria-valuemin={AI_COMPOSER_HEIGHT_MIN}
        aria-valuemax={maximumHeight}
        aria-valuenow={Math.round(height)}
        title="拖动调整输入框高度"
        tabIndex={0}
        onPointerDown={onResizePointerDown}
        onPointerMove={onResizePointerMove}
        onPointerUp={onResizePointerUp}
        onPointerCancel={onResizePointerCancel}
        onKeyDown={(event) => {
          if (event.key !== 'ArrowUp' && event.key !== 'ArrowDown') return;
          event.preventDefault();
          onResizeKey(event.key === 'ArrowUp' ? 'up' : 'down', event.shiftKey);
        }}
      />
      <div className="ai-composer-input">
        <textarea
          ref={textareaRef}
          rows={3}
          style={{ height }}
          value={value}
          disabled={disabled}
          role="combobox"
          aria-autocomplete="list"
          aria-controls={mentionMenuOpen ? mentionMenuId : undefined}
          aria-expanded={mentionMenuOpen}
          aria-activedescendant={mentionMenuOpen && activeSuggestion
            ? `ai-mention-${assistantId}-${activeSuggestion.id}`
            : undefined}
          placeholder="直接描述任务；输入 @ 查看通用命令或引用画布节点；Enter 发送，Ctrl/⌘ + Enter 换行"
          onCompositionStart={onCompositionStart}
          onCompositionEnd={onCompositionEnd}
          onChange={onChange}
          onClick={onCaretChange}
          onSelect={onCaretChange}
          onKeyUp={onCaretChange}
          onKeyDown={onKeyDown}
        />
        <IconButton
          icon={status === 'generating' ? 'stop' : 'send'}
          label={status === 'generating' ? '停止本次生成' : '发送给模型'}
          className="ai-send-button"
          disabled={status !== 'generating' && sendDisabled}
          onClick={status === 'generating' ? onStop : onSend}
        />
        {mentionMenuOpen && (
          <div id={mentionMenuId} className="ai-mention-menu" role="listbox" aria-label="@ 命令和文字节点">
            {mentionSuggestions.map((suggestion, index) => (
              <button
                key={suggestion.id}
                id={`ai-mention-${assistantId}-${suggestion.id}`}
                type="button"
                role="option"
                aria-selected={index === activeMentionIndex}
                className={`ai-mention-option ${suggestion.kind}${index === activeMentionIndex ? ' is-active' : ''}`}
                onPointerDown={(event) => event.preventDefault()}
                onPointerMove={() => onActiveMention(index)}
                onClick={() => onChooseMention(suggestion)}
              >
                <Icon name={suggestion.kind === 'source' ? 'text' : suggestion.kind === 'memory' ? 'at' : 'command'} size={14} />
                <span><strong>{suggestion.label}</strong><small>{suggestion.detail}</small></span>
              </button>
            ))}
            {mentionSuggestions.length === 0 && (
              <p className="ai-mention-empty">没有匹配的指令或文字节点</p>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
