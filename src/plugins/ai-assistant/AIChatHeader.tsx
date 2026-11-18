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
  const modelLabel = selectedProvider
    ? selectedProvider.model || '未填写模型'
    : providerCatalog.options.length ? '请选择模型' : '模型未配置';

  return (
    <div className="ai-chat-topbar">
      <div className="ai-model-controls">
        <label className="ai-model-selector">
          <span className="sr-only">大模型</span>
          <span className="ai-model-selector-size" aria-hidden="true">{modelLabel}</span>
          <select
            value={selectedProvider ? selectedProviderId : ''}
            aria-label="当前模型平台"
            title={`切换模型：${modelLabel}`}
            disabled={!providerSelectionAvailable || providerCatalog.options.length === 0}
            onChange={(event) => onSelectProvider(event.target.value)}
          >
            {!selectedProvider && <option value="" disabled hidden>{modelLabel}</option>}
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
      <IconButton
        icon="template"
        className={`icon-button ai-prompt-active-summary${selectedPromptTemplate ? ' is-active' : ''}`}
        label={`Prompt：${selectedPromptTemplate?.name ?? '默认通用'}。查看或切换 Prompt 模板`}
        onClick={onOpenPromptTemplates}
      />
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
