import { createId, type PluginContext } from '../../core/contracts.ts';
import type { CommandContract } from '../../protocols/commands.ts';
import type {
  AIPromptTemplateCatalog,
  AIPromptTemplateRecord,
} from '../../protocols/ai.ts';
import { AI_UI_NAMESPACE } from './assistant-workspace.ts';
import {
  isPromptTemplateExportPayload,
  isPromptTemplateIdPayload,
  isPromptTemplateImportPayload,
  type PromptTemplateExportPayload,
  type PromptTemplateIdPayload,
  type PromptTemplateImportPayload,
} from './command-payloads.ts';
import {
  isPromptTemplateCatalog,
  isPromptTemplateDraft,
  parsePromptTemplateFile,
  serializePromptTemplateFile,
  uniquePromptTemplateName,
  type PromptTemplateDraft,
} from './prompt-template-files.ts';

declare module '../../protocols/commands.ts' {
  interface ApplicationCommandMap {
    'ai.promptTemplate.import': CommandContract<PromptTemplateImportPayload, { id: string }>;
    'ai.promptTemplate.save': CommandContract<PromptTemplateDraft, { id: string }>;
  }
}

export const PERSONAL_PROMPT_TEMPLATES_KEY = 'prompt-templates@1';
const PROMPT_TEMPLATE_LIMIT = 24;
const PROMPT_TEMPLATE_FILE_SIZE_LIMIT = 256 * 1024;

export interface PromptTemplateRuntime {
  restorePersonal(): void;
}

export function registerPromptTemplateRuntime(
  context: PluginContext,
  readCatalog: () => AIPromptTemplateCatalog,
): PromptTemplateRuntime {
  context.commands.register({
    type: 'ai.promptTemplate.save',
    validate: isPromptTemplateDraft,
    handle: (payload) => {
      const catalog = readCatalog();
      const now = Date.now();
      const existing = payload.id
        ? catalog.templates.find((template) => template.id === payload.id)
        : undefined;
      if (payload.id && !existing) throw new Error('Prompt 模板已经不存在');
      if (!existing && catalog.templates.length >= PROMPT_TEMPLATE_LIMIT) {
        throw new Error(`Prompt 模板最多保存 ${PROMPT_TEMPLATE_LIMIT} 个`);
      }
      const template: AIPromptTemplateRecord = {
        id: existing?.id ?? createId('ai-prompt-template'),
        name: payload.name.trim(),
        systemInstruction: payload.systemInstruction.trim(),
        userInstruction: payload.userInstruction.trim(),
        createdAt: existing?.createdAt ?? now,
        updatedAt: now,
      };
      const templates = existing
        ? catalog.templates.map((candidate) => candidate.id === existing.id ? template : candidate)
        : [...catalog.templates, template];
      return {
        result: { id: template.id },
        transaction: promptTemplateTransaction('保存 AI Prompt 模板', templates, template.id),
      };
    },
  });
  context.commands.register<PromptTemplateIdPayload, { removed: boolean }>({
    type: 'ai.promptTemplate.remove',
    validate: isPromptTemplateIdPayload,
    handle: (payload) => {
      if (!payload.templateId) return { result: { removed: false } };
      const catalog = readCatalog();
      const templates = catalog.templates.filter((template) => template.id !== payload.templateId);
      if (templates.length === catalog.templates.length) return { result: { removed: false } };
      return {
        result: { removed: true },
        transaction: promptTemplateTransaction(
          '删除 AI Prompt 模板',
          templates,
          catalog.activeTemplateId === payload.templateId ? undefined : catalog.activeTemplateId,
        ),
      };
    },
  });
  context.commands.register<PromptTemplateIdPayload, { activeTemplateId?: string }>({
    type: 'ai.promptTemplate.activate',
    validate: isPromptTemplateIdPayload,
    handle: (payload) => {
      const catalog = readCatalog();
      if (payload.templateId && !catalog.templates.some((template) => template.id === payload.templateId)) {
        throw new Error('Prompt 模板已经不存在');
      }
      return {
        result: { activeTemplateId: payload.templateId },
        transaction: {
          label: '切换 AI Prompt 模板',
          history: false,
          patches: [{
            op: payload.templateId ? 'set' as const : 'delete' as const,
            domain: 'workspace' as const,
            namespace: AI_UI_NAMESPACE,
            key: 'activePromptTemplateId',
            ...(payload.templateId ? { value: payload.templateId } : {}),
          }],
          events: [{
            type: 'ai.prompt.configuration.changed',
            payload: { activeTemplateId: payload.templateId },
          }],
        },
      };
    },
  });
  context.commands.register<AIPromptTemplateCatalog>({
    type: 'ai.promptTemplate.restorePersonal',
    validate: isPromptTemplateCatalog,
    handle: (payload) => ({
      transaction: promptTemplateTransaction(
        '恢复本机 Prompt 模板',
        payload.templates,
        payload.activeTemplateId,
      ),
    }),
  });
  context.commands.register<PromptTemplateExportPayload, { filename: string }>({
    type: 'ai.promptTemplate.export',
    validate: isPromptTemplateExportPayload,
    handle: async (payload) => {
      const template = readCatalog().templates.find((candidate) => candidate.id === payload.templateId);
      if (!template) throw new Error('Prompt 模板已经不存在');
      const blob = new Blob([serializePromptTemplateFile(template)], { type: 'text/plain;charset=utf-8' });
      const writable = await payload.destination.createWritable();
      try {
        await writable.write(blob);
        await writable.close();
      } catch (error) {
        await writable.abort?.().catch(() => undefined);
        throw error;
      }
      return { result: { filename: payload.destination.name } };
    },
  });
  context.commands.register({
    type: 'ai.promptTemplate.import',
    validate: isPromptTemplateImportPayload,
    handle: async (payload) => {
      const file = await payload.source.getFile();
      if (file.size > PROMPT_TEMPLATE_FILE_SIZE_LIMIT) {
        throw new Error('Prompt 模板文件不能超过 256 KB');
      }
      const imported = parsePromptTemplateFile(await file.text());
      const catalog = readCatalog();
      if (catalog.templates.length >= PROMPT_TEMPLATE_LIMIT) {
        throw new Error(`Prompt 模板最多保存 ${PROMPT_TEMPLATE_LIMIT} 个`);
      }
      const now = Date.now();
      const template: AIPromptTemplateRecord = {
        id: createId('ai-prompt-template'),
        name: uniquePromptTemplateName(imported.name, catalog.templates),
        systemInstruction: imported.systemInstruction,
        userInstruction: imported.userInstruction,
        createdAt: now,
        updatedAt: now,
      };
      return {
        result: { id: template.id },
        transaction: promptTemplateTransaction(
          '导入并启用 AI Prompt 模板',
          [...catalog.templates, template],
          template.id,
        ),
      };
    },
  });

  context.events.subscribe('ai.prompt.configuration.changed', () => {
    void context.commands.dispatch('system.preferences.set', {
      key: PERSONAL_PROMPT_TEMPLATES_KEY,
      value: readCatalog(),
    }).catch((error) => context.diagnostics.warn('保存本机 Prompt 模板失败', error));
  });

  return {
    restorePersonal: () => {
      void context.queries.ask<unknown>('system.preferences.get', { key: PERSONAL_PROMPT_TEMPLATES_KEY })
        .then((value) => {
          if (isPromptTemplateCatalog(value)) {
            return context.commands.dispatch('ai.promptTemplate.restorePersonal', value);
          }
          return undefined;
        })
        .catch((error) => context.diagnostics.warn('读取本机 Prompt 模板失败', error));
    },
  };
}

export function promptTemplateTransaction(
  label: string,
  templates: AIPromptTemplateRecord[],
  activeTemplateId?: string,
) {
  return {
    label,
    history: false,
    patches: [
      {
        op: 'set' as const,
        domain: 'workspace' as const,
        namespace: AI_UI_NAMESPACE,
        key: 'promptTemplates',
        value: templates,
      },
      activeTemplateId
        ? {
            op: 'set' as const,
            domain: 'workspace' as const,
            namespace: AI_UI_NAMESPACE,
            key: 'activePromptTemplateId',
            value: activeTemplateId,
          }
        : {
            op: 'delete' as const,
            domain: 'workspace' as const,
            namespace: AI_UI_NAMESPACE,
            key: 'activePromptTemplateId',
          },
    ],
    events: [{ type: 'ai.prompt.configuration.changed', payload: { activeTemplateId } }],
  };
}
