'use client';

import { useState } from 'react';
import type { ViewClient } from '../../core/contracts.ts';
import type { AIPromptTemplateCatalog, AIPromptTemplateRecord } from '../../protocols/ai.ts';
import { IconButton } from '../../ui/Icon.tsx';
import { ProcessingLabel } from '../../ui/ProcessingIndicator.tsx';
import {
  chooseNativePromptTemplateOpen,
  chooseNativePromptTemplateSave,
} from '../../ui/native-save.ts';
import type { PromptTemplateDraft } from './prompt-template-files.ts';

const EMPTY_PROMPT_DRAFT: PromptTemplateDraft = {
  name: '',
  systemInstruction: '',
  userInstruction: '',
};

export function AIPromptTemplateCenter({
  client,
  catalog,
  assistantId,
  selectedTemplateId,
}: {
  client: ViewClient;
  catalog: AIPromptTemplateCatalog;
  assistantId: string;
  selectedTemplateId?: string;
}) {
  const active = catalog.templates.find((template) => template.id === selectedTemplateId);
  const [draft, setDraft] = useState<PromptTemplateDraft>(
    active ? promptTemplateDraft(active) : EMPTY_PROMPT_DRAFT,
  );
  const [message, setMessage] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  const run = async (operation: () => Promise<unknown>, success: string) => {
    setError('');
    setBusy(true);
    try {
      await operation();
      setMessage(success);
    } catch (reason) {
      setError(errorMessage(reason));
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className="ai-prompt-center" aria-label="AI Prompt 模板" aria-busy={busy || undefined}>
      <header>
        <div><span className="eyebrow">个人工作区</span><h3>Prompt 模板</h3></div>
        <div>
          <IconButton
            icon="add"
            label="新建 Prompt 模板"
            onClick={() => {
              setDraft(EMPTY_PROMPT_DRAFT);
              setMessage('请填写新模板');
              setError('');
            }}
          />
          <IconButton
            icon="folder-open"
            label="从本地导入 Prompt 模板"
            onClick={() => void run(async () => {
              const source = await chooseNativePromptTemplateOpen();
              if (!source) throw new Error('当前浏览器不支持原生文件选择，请使用 Chromium 版 Echo-8');
              const imported = await client.dispatch('ai.promptTemplate.import', { source });
              await client.dispatch('ai.assistant.setPromptTemplate', {
                assistantId,
                resourceId: imported.id,
              });
            }, '模板已从本地导入并启用')}
          />
          <IconButton
            icon="save"
            label="保存并启用 Prompt 模板"
            className="primary-icon-button"
            disabled={!draft.name.trim() || !(draft.systemInstruction.trim() || draft.userInstruction.trim())}
            onClick={() => void run(async () => {
              const saved = await client.dispatch('ai.promptTemplate.save', draft);
              await client.dispatch('ai.assistant.setPromptTemplate', {
                assistantId,
                resourceId: saved.id,
              });
              const destination = await chooseNativePromptTemplateSave(draft.name);
              if (!destination) throw new Error('模板已保存到个人工作区，但当前浏览器不能打开原生保存窗口');
              await client.dispatch('ai.promptTemplate.export', {
                templateId: saved.id,
                destination,
              });
            }, '模板已保存、启用并写入本地文件')}
          />
          <IconButton
            icon="trash"
            label="删除当前 Prompt 模板"
            disabled={!draft.id}
            onClick={() => draft.id && void run(
              async () => {
                await client.dispatch('ai.promptTemplate.remove', { templateId: draft.id });
                if (draft.id === selectedTemplateId) {
                  await client.dispatch('ai.assistant.setPromptTemplate', { assistantId });
                }
              },
              '模板已删除，恢复默认通用协议',
            )}
          />
        </div>
      </header>
      <p>模板只保存在个人工作区，不进入画布正文。基础的证据、隐私、冲突披露和提案审查规则始终保留。</p>
      <label className="ai-field">
        <span>当前模板</span>
        <select
          value={selectedTemplateId ?? ''}
          onChange={(event) => void run(
            () => client.dispatch('ai.assistant.setPromptTemplate', {
              assistantId,
              resourceId: event.target.value || undefined,
            }),
            event.target.value ? '已切换 Prompt 模板' : '已恢复默认通用协议',
          )}
        >
          <option value="">默认通用协议</option>
          {catalog.templates.map((template) => (
            <option key={template.id} value={template.id}>{template.name}</option>
          ))}
        </select>
      </label>
      <label className="ai-field">
        <span>模板名称</span>
        <input
          value={draft.name}
          maxLength={80}
          placeholder="例如：代码审查、新闻稿、产品分析"
          onChange={(event) => setDraft({ ...draft, name: event.target.value })}
        />
      </label>
      <label className="ai-field ai-prompt-field">
        <span>系统工作方式</span>
        <textarea
          value={draft.systemInstruction}
          placeholder="定义角色、判断标准、输出纪律和禁止事项"
          onChange={(event) => setDraft({ ...draft, systemInstruction: event.target.value })}
        />
      </label>
      <label className="ai-field ai-prompt-field">
        <span>本次任务前缀</span>
        <textarea
          value={draft.userInstruction}
          placeholder="附加到每次任务前；可以为空"
          onChange={(event) => setDraft({ ...draft, userInstruction: event.target.value })}
        />
      </label>
      <small>
        可用变量：{'{{operation}}'}、{'{{sourceKinds}}'}、{'{{sourceCount}}'}。内容类型插件还可以通过
        <code>ai.promptPolicy@1</code> 提供自己的动态规则。
      </small>
      {busy
        ? <p className="ai-message" role="status"><ProcessingLabel size={9}>正在处理 Prompt 模板…</ProcessingLabel></p>
        : message && <p className="ai-message">{message}</p>}
      {error && <p className="ai-error" role="alert">{error}</p>}
    </section>
  );
}

function promptTemplateDraft(template: AIPromptTemplateRecord): PromptTemplateDraft {
  return {
    id: template.id,
    name: template.name,
    systemInstruction: template.systemInstruction,
    userInstruction: template.userInstruction,
  };
}

function errorMessage(reason: unknown): string {
  return reason instanceof Error ? reason.message : String(reason);
}
