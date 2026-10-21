import type { SemanticProviderProfileDraft } from '../../protocols/semantic.ts';

export interface SemanticProviderPreset {
  id: string;
  label: string;
  available: boolean;
  draft?: SemanticProviderProfileDraft;
  modelHint: string;
  note: string;
}

export const SEMANTIC_PROVIDER_PRESETS: readonly SemanticProviderPreset[] = [
  {
    id: 'openai',
    label: 'OpenAI',
    available: true,
    draft: {
      platform: 'OpenAI', label: 'text-embedding-3-small',
      endpoint: 'https://api.openai.com/v1/embeddings', model: 'text-embedding-3-small',
      apiStyle: 'openai-compatible', authentication: 'bearer',
      allowRemoteContent: false, maxBatchSize: 32,
    },
    modelHint: 'text-embedding-3-small / text-embedding-3-large',
    note: '使用 OpenAI API Key；ChatGPT 订阅不是 API 额度。',
  },
  {
    id: 'qwen',
    label: '阿里云百炼 / 通义千问',
    available: true,
    draft: {
      platform: '阿里云百炼', label: 'qwen3.7-text-embedding',
      endpoint: 'https://{WorkspaceId}.cn-beijing.maas.aliyuncs.com/compatible-mode/v1/embeddings',
      model: 'qwen3.7-text-embedding',
      apiStyle: 'openai-compatible', authentication: 'bearer',
      allowRemoteContent: false, maxBatchSize: 20,
    },
    modelHint: 'qwen3.7-text-embedding / text-embedding-v4',
    note: '把地址里的 {WorkspaceId} 换成百炼业务空间 ID，KEY 和地域必须一致。',
  },
  {
    id: 'doubao',
    label: '火山方舟 / 豆包',
    available: true,
    draft: {
      platform: '火山方舟', label: 'doubao-embedding-vision',
      endpoint: 'https://ark.cn-beijing.volces.com/api/coding/v3/embeddings',
      model: 'doubao-embedding-vision',
      apiStyle: 'openai-compatible', authentication: 'bearer',
      allowRemoteContent: false, maxBatchSize: 16,
    },
    modelHint: '填写当前套餐或接入点开放的 Embedding 模型 ID',
    note: '该范本使用方舟 Coding Plan 的 OpenAI 兼容向量地址；其他方舟套餐请按控制台替换地址和模型。',
  },
  {
    id: 'gemini',
    label: 'Google Gemini',
    available: true,
    draft: {
      platform: 'Google Gemini', label: 'gemini-embedding-001',
      endpoint: 'https://generativelanguage.googleapis.com/v1beta/models/gemini-embedding-001:batchEmbedContents',
      model: 'gemini-embedding-001',
      apiStyle: 'gemini', authentication: 'api-key',
      allowRemoteContent: false, maxBatchSize: 32,
    },
    modelHint: 'gemini-embedding-001',
    note: '使用 Google AI Studio API Key；此范本调用 Gemini 原生批量向量接口。',
  },
  {
    id: 'deepseek',
    label: 'DeepSeek（暂无公开 Embedding API）',
    available: false,
    modelHint: '',
    note: 'DeepSeek 当前公开 API 主要是对话模型，不能把对话地址当成语义向量地址。',
  },
  {
    id: 'kimi',
    label: 'Moonshot / Kimi（暂无公开 Embedding API）',
    available: false,
    modelHint: '',
    note: 'Kimi 当前公开接入不能直接作为 Echo-8 的向量接口。',
  },
] as const;

export function applySemanticProviderPreset(id: string): SemanticProviderProfileDraft | undefined {
  const preset = SEMANTIC_PROVIDER_PRESETS.find((candidate) => candidate.id === id && candidate.available);
  return preset?.draft ? { ...preset.draft } : undefined;
}

export function matchSemanticProviderPreset(profile: Pick<SemanticProviderProfileDraft, 'endpoint' | 'apiStyle'>): string {
  return SEMANTIC_PROVIDER_PRESETS.find((preset) => preset.available && preset.draft &&
    preset.draft.endpoint === profile.endpoint && preset.draft.apiStyle === profile.apiStyle)?.id ?? '';
}
