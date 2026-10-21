import type { AIProviderProfileDraft } from './types.ts';

export interface AIProviderPreset {
  id: string;
  label: string;
  draft: AIProviderProfileDraft;
  /** Suggestions only. The model field always accepts any provider-supported model id. */
  suggestedModels: readonly string[];
  modelHint: string;
  note: string;
}

export const AI_PROVIDER_PRESETS: readonly AIProviderPreset[] = [
  {
    id: 'novelforge-codex',
    label: 'NovelForge Codex（本机）',
    draft: {
      platform: 'NovelForge Codex', label: 'NovelForge Codex（本机）',
      endpoint: 'http://127.0.0.1:32147/v1/chat/completions', model: 'novelforge-codex',
      contextWindowTokens: 200_000,
      transport: 'novelforge-connector',
      authentication: 'none', apiStyle: 'openai', memoryToolEnabled: false,
      // Defensive legacy setting: even if an old UI injects a key, it never enters backups.
      secretPersistence: 'session-only',
    },
    suggestedModels: ['novelforge-codex'],
    modelHint: 'novelforge-codex（由本机 Codex 决定实际模型）',
    note: '先在 NovelForge 面板完成一次本机配对；以后 AI 助手会自动复用连接，不需要 API Key。',
  },
  {
    id: 'deepseek',
    label: 'DeepSeek',
    draft: {
      platform: 'DeepSeek', label: 'DeepSeek 对话',
      endpoint: 'https://api.deepseek.com/chat/completions', model: 'deepseek-chat',
      authentication: 'bearer', apiStyle: 'openai',
    },
    suggestedModels: ['deepseek-chat', 'deepseek-reasoner'],
    modelHint: 'deepseek-chat / deepseek-reasoner',
    note: '使用 DeepSeek 平台创建的 API Key。',
  },
  {
    id: 'openai',
    label: 'OpenAI / GPT',
    draft: {
      platform: 'OpenAI', label: 'GPT 对话',
      endpoint: 'https://api.openai.com/v1/chat/completions', model: 'gpt-4.1-mini',
      authentication: 'bearer', apiStyle: 'openai',
    },
    suggestedModels: ['gpt-4.1-mini', 'gpt-4.1', 'gpt-5-search-api'],
    modelHint: '填写账号当前可用的 GPT 模型名称',
    note: '使用 OpenAI API Key；ChatGPT 订阅不是 API 额度。',
  },
  {
    id: 'kimi',
    label: 'Moonshot / Kimi',
    draft: {
      platform: 'Moonshot Kimi', label: 'Kimi 对话',
      endpoint: 'https://api.moonshot.cn/v1/chat/completions', model: 'kimi-k3',
      authentication: 'bearer', apiStyle: 'openai',
    },
    suggestedModels: ['kimi-k3'],
    modelHint: 'kimi-k3，或 Moonshot 控制台当前开放的模型名称',
    note: '使用 Moonshot 开放平台 API Key。',
  },
  {
    id: 'qwen',
    label: '阿里云百炼 / 通义千问',
    draft: {
      platform: '阿里云百炼', label: '通义千问对话',
      endpoint: 'https://dashscope.aliyuncs.com/compatible-mode/v1/chat/completions', model: 'qwen-plus',
      authentication: 'bearer', apiStyle: 'openai',
    },
    suggestedModels: ['qwen-plus', 'qwen-max', 'qwen-turbo'],
    modelHint: 'qwen-plus，或百炼控制台给出的模型名称',
    note: 'KEY 和接口地域必须一致；也可换成工作空间专属域名。',
  },
  {
    id: 'doubao',
    label: '火山方舟 / 豆包',
    draft: {
      platform: '火山方舟', label: '豆包对话',
      endpoint: 'https://ark.cn-beijing.volces.com/api/v3/chat/completions', model: 'doubao-seed-2-0-lite-260215',
      authentication: 'bearer', apiStyle: 'openai',
    },
    suggestedModels: ['doubao-seed-2-0-lite-260215'],
    modelHint: '填写方舟控制台当前开放的模型 ID 或推理接入点 ID',
    note: '使用火山方舟专用 API Key；不要填传统云账号 AccessKey。',
  },
  {
    id: 'gemini',
    label: 'Google Gemini',
    draft: {
      platform: 'Google Gemini', label: 'Gemini 对话',
      endpoint: 'https://generativelanguage.googleapis.com', model: 'gemini-2.5-flash',
      authentication: 'api-key', apiStyle: 'gemini',
    },
    suggestedModels: ['gemini-2.5-flash', 'gemini-2.5-pro', 'gemini-2.5-flash-lite'],
    modelHint: '填写 Google AI Studio 当前开放的 Gemini 模型名称',
    note: '使用 Google AI Studio API Key；系统会自动拼接原生模型路径。',
  },
] as const;

export function applyAIProviderPreset(id: string): AIProviderProfileDraft | undefined {
  const preset = AI_PROVIDER_PRESETS.find((candidate) => candidate.id === id);
  return preset ? { ...preset.draft } : undefined;
}

export function matchAIProviderPreset(profile: Pick<AIProviderProfileDraft, 'endpoint' | 'apiStyle'>): string {
  return AI_PROVIDER_PRESETS.find((preset) =>
    preset.draft.endpoint === profile.endpoint && preset.draft.apiStyle === profile.apiStyle)?.id ?? '';
}
