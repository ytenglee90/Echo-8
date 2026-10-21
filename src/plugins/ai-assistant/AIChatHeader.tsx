'use client';

import type {
  AIMemoryCatalogSnapshot,
  AIPromptTemplateRecord,
  AIProviderCatalog,
  AIProviderOption,
} from '../../protocols/ai.ts';
import type { ViewClient } from '../../core/contracts.ts';
import { IconButton } from '../../ui/Icon.tsx';
import { AIMemoryShortcut } from './AIMemoryViews.tsx';

export function AIChatHeader({
  client,
  assistantId,
  providerSelectionAvailable,
  providerCatalog,
  selectedProviderId,
  selectedProvider,
  webSearchEnabled,
  selectedPromptTemplate,
  memoryCatalog,
  selectedMemorySourceIds,
  contextMode,
  onSelectProvider,
  onToggleWebSearch,
  onOpenPromptTemplates,
}: {
  client: ViewClient;
  assistantId: string;
  providerSelectionAvailable: boolean;
  providerCatalog: AIProviderCatalog;
  selectedProviderId: string;
  selectedProvider?: AIProviderOption;
  webSearchEnabled: boolean;
  selectedPromptTemplate?: AIPromptTemplateRecord;
  memoryCatalog: AIMemoryCatalogSnapshot;
  selectedMemorySourceIds: ReadonlySet<string>;
  contextMode: 'automatic' | 'explicit-only';
  onSelectProvider: (resourceId: string) => void;
  onToggleWebSearch: () => void;
  onOpenPromptTemplates: () => void;
}) {
  return (
    <div className="ai-chat-topbar">
      <div className="ai-model-controls">
        <label className="ai-model-selector">
          <span className="sr-only">大模型</span>
          <select
            value={selectedProviderId}
            aria-label="当前模型平台"
            disabled={!providerSelectionAvailable || providerCatalog.options.length === 0}
            onChange={(event) => onSelectProvider(event.target.value)}
          >
            <option value="" disabled>模型未配置</option>
            {providerCatalog.options.map((option) => (
              <option key={option.id} value={option.id}>
                {option.model || '未填写模型'}
              </option>
            ))}
          </select>
        </label>
        <IconButton
          icon="globe"
          label={webSearchEnabled
            ? `关闭联网（当前：${selectedProvider?.webSearchLabel ?? '模型平台原生搜索'}）`
            : selectedProvider?.webSearchSupported
              ? `开启联网（${selectedProvider.webSearchLabel ?? '模型平台原生搜索'}）`
              : '当前模型连接不支持已验证的原生联网搜索'}
          aria-pressed={webSearchEnabled}
          className={`icon-button ai-web-search-toggle${webSearchEnabled ? ' is-active' : ''}`}
          disabled={!selectedProvider || (!selectedProvider.webSearchSupported && !webSearchEnabled)}
          onClick={onToggleWebSearch}
        />
      </div>
      <button
        type="button"
        className={`ai-prompt-active-summary${selectedPromptTemplate ? ' is-active' : ''}`}
        title={`当前使用：${selectedPromptTemplate?.name ?? '默认通用协议'}。点击查看或切换 Prompt 模板`}
        onClick={onOpenPromptTemplates}
      >Prompt：{selectedPromptTemplate?.name ?? '默认通用'}</button>
      <AIMemoryShortcut
        client={client}
        assistantId={assistantId}
        catalog={memoryCatalog}
        selectedSourceIds={selectedMemorySourceIds}
        contextMode={contextMode}
      />
    </div>
  );
}
