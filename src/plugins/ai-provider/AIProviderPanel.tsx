'use client';

import { useEffect, useState, useSyncExternalStore } from 'react';
import type { ViewClient } from '../../core/contracts.ts';
import { IconButton } from '../../ui/Icon.tsx';
import { Icon } from '../../ui/Icon.tsx';
import {
  chooseNativePersonalAIBackup,
  chooseNativePersonalAIBackupOpen,
} from '../../ui/native-save.ts';
import { AI_PROVIDER_NAMESPACE } from './model.ts';
import type {
  AIProviderPanelState,
  AIProviderProfileDraft,
  AIProviderProfileState,
} from './types.ts';
import { AI_PROVIDER_PRESETS, applyAIProviderPreset, matchAIProviderPreset } from './presets.ts';

const EMPTY_DRAFT: AIProviderProfileDraft = {
  label: '',
  platform: '',
  endpoint: '',
  model: '',
  transport: 'http',
  authentication: 'bearer',
  apiStyle: 'openai',
  memoryToolEnabled: false,
  secretPersistence: 'personal-local',
};

const EMPTY_STATE: AIProviderPanelState = {
  endpoint: '',
  model: '',
  transport: 'http',
  authentication: 'bearer',
  apiStyle: 'openai',
  memoryToolEnabled: false,
  secretPersistence: 'personal-local',
  profiles: [],
  hasSessionKey: false,
  configured: false,
};

export function AIProviderPanel({ client }: { client: ViewClient }) {
  const modelListId = 'ai-provider-model-suggestions';
  const version = useSyncExternalStore(
    client.subscribeState,
    () => client.getOwnStateVersion(AI_PROVIDER_NAMESPACE),
    () => 0,
  );
  const [state, setState] = useState<AIProviderPanelState>(EMPTY_STATE);
  const [draft, setDraft] = useState<AIProviderProfileDraft>(EMPTY_DRAFT);
  const [apiKey, setApiKey] = useState('');
  const [message, setMessage] = useState('');
  const [error, setError] = useState('');
  const [presetId, setPresetId] = useState('');

  const applyState = (next: AIProviderPanelState, preferredId?: string) => {
    setState(next);
    const selected = next.profiles.find((profile) => profile.id === preferredId) ??
      next.profiles.find((profile) => profile.id === next.activeProfileId);
    setDraft(selected ? profileDraft(selected) : { ...EMPTY_DRAFT });
    setPresetId(selected ? matchAIProviderPreset(selected) : '');
  };
  const refresh = async (preferredId?: string) => {
    const next = await client.ask<AIProviderPanelState>('aiProvider.state');
    applyState(next, preferredId);
  };

  useEffect(() => {
    let current = true;
    void client.ask<AIProviderPanelState>('aiProvider.state').then((next) => {
      if (current) applyState(next);
    });
    return () => { current = false; };
  }, [client, version]);

  const run = async (operation: () => Promise<unknown>, success: string, preferredId?: string) => {
    setError('');
    try {
      await operation();
      setMessage(success);
      await refresh(preferredId);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    }
  };
  const selectProfile = (profileId: string) => {
    setApiKey('');
    setPresetId('');
    void run(
      () => client.dispatch('aiProvider.profile.activate', { profileId }),
      '已切换当前模型连接',
      profileId,
    );
  };
  const saveProfile = () => {
    const normalized = aiDraftForSave(draft, presetId);
    void run(async () => {
      const saved = await client.dispatch('aiProvider.profile.save', normalized);
      if (normalized.authentication !== 'none' && apiKey.trim()) {
        await client.dispatch('aiProvider.setSessionKey', { profileId: saved.id, apiKey });
      }
      setApiKey('');
    }, draft.id ? '连接配置已更新' : '平台连接已添加', draft.id);
  };
  const selected = state.profiles.find((profile) => profile.id === draft.id);
  const exportPersonalConfig = () => {
    void (async () => {
      try {
        if (state.personalBackupName) {
          await run(() => client.dispatch('aiProvider.personalBackup.sync'), '配置备份已更新');
          return;
        }
        const handle = await chooseNativePersonalAIBackup();
        if (handle) await run(
          () => client.dispatch('aiProvider.personalBackup.bind', { handle }),
          '当前配置已导出，并会自动同步后续更新',
        );
      } catch (reason) {
        if (!(reason instanceof DOMException && reason.name === 'AbortError')) {
          setError(reason instanceof Error ? reason.message : String(reason));
        }
      }
    })();
  };
  const importPersonalConfig = () => {
    void (async () => {
      try {
        const handle = await chooseNativePersonalAIBackupOpen();
        if (handle) await run(
          () => client.dispatch('aiProvider.personalBackup.import', { handle }),
          '本地配置已导入',
        );
      } catch (reason) {
        if (!(reason instanceof DOMException && reason.name === 'AbortError')) {
          setError(reason instanceof Error ? reason.message : String(reason));
        }
      }
    })();
  };

  return (
    <section className="ai-provider-panel" aria-label="AI 模型连接与密钥">
      <header className="ai-provider-transfer-actions" aria-label="配置导出与导入">
        <div>
          <strong>配置迁移</strong>
          <small>{state.personalBackupName ? `已绑定：${state.personalBackupName}（后续会自动同步）` : '导出后可在另一台电脑导入连接与 KEY。'}</small>
        </div>
        <span>
          <button type="button" onClick={exportPersonalConfig}><Icon name="save" size={14} />导出配置</button>
          <button type="button" onClick={importPersonalConfig}><Icon name="folder-open" size={14} />从本地导入</button>
        </span>
      </header>
      <section className="ai-provider-connection-module" aria-label="对话模型连接">
      <header className="ai-provider-setup-intro">
        <span className="ai-provider-setup-eyebrow">对话模型</span>
        <h2>连接模型</h2>
        <p>选择平台并按提示保存；NovelForge Codex 会自动复用本机配对。</p>
      </header>

      <div className="ai-provider-profile-toolbar">
        <select
          aria-label="当前模型平台连接"
          value={draft.id ?? ''}
          onChange={(event) => selectProfile(event.target.value)}
        >
          <option value="" disabled>{state.profiles.length ? '选择平台连接' : '还没有平台连接'}</option>
          {state.profiles.map((profile) => (
            <option key={profile.id} value={profile.id}>
              {aiProfileLabel(profile)}{profile.configured ? '' : '（未就绪）'}
            </option>
          ))}
        </select>
        <IconButton
          icon="add"
          label="新建模型连接"
          className="ai-provider-inline-action ai-provider-inline-icon-action"
          onClick={() => {
            setDraft({ ...EMPTY_DRAFT });
            setApiKey('');
            setPresetId('');
            setMessage('正在添加新的平台连接');
            setError('');
          }}
        />
        <IconButton
          icon="trash"
          label="删除当前平台连接"
          disabled={!draft.id}
          onClick={() => draft.id && void run(
            () => client.dispatch('aiProvider.profile.remove', { profileId: draft.id }),
            '平台连接已删除',
          )}
        />
      </div>

      <div className={`ai-provider-state ${selected?.configured ? 'ready' : ''}`}>
        <i />{selected?.configured ? '当前连接已就绪' : draft.id ? '当前连接还缺少必要参数' : '填写并保存新的平台连接'}
      </div>
      <label className="ai-field">
        <span>平台</span>
        <select aria-label="选择平台" value={presetId} onChange={(event) => {
          const id = event.target.value;
          setPresetId(id);
          const next = applyAIProviderPreset(id);
          if (!next) return;
          setDraft(next);
          setApiKey('');
          const preset = AI_PROVIDER_PRESETS.find((item) => item.id === id);
          setMessage(preset?.note ?? `已填入${preset?.label ?? '平台'}推荐连接；请核对模型名称并填写 KEY`);
          setError('');
        }}>
          <option value="">手动填写 / 选择平台范本</option>
          {AI_PROVIDER_PRESETS.map((preset) => (
            <option key={preset.id} value={preset.id}>{preset.label}</option>
          ))}
        </select>
      </label>
      <label className="ai-field">
        <span>模型</span>
        <input
          list={modelListId}
          value={draft.model}
          placeholder={AI_PROVIDER_PRESETS.find((item) => item.id === presetId)?.modelHint ?? '由对应平台提供'}
          onChange={(event) => setDraft({ ...draft, model: event.target.value })}
        />
        <datalist id={modelListId}>
          {(AI_PROVIDER_PRESETS.find((item) => item.id === presetId)?.suggestedModels ?? [])
            .map((model) => <option key={model} value={model} />)}
        </datalist>
      </label>
      {draft.authentication !== 'none' && (
        <label className="ai-field">
          <span>{draft.secretPersistence === 'session-only' ? '配对令牌' : 'API KEY'}</span>
          <input
            type="password"
            autoComplete="off"
            value={apiKey}
            placeholder={draft.secretPersistence === 'session-only'
              ? selected?.hasSessionKey ? '本次页面会话已配对；留空保持' : '粘贴 Codex 返回的一次性配对令牌'
              : selected?.hasSessionKey ? '本机已保存；留空保持不变' : '保存在本机个人配置区'}
            onChange={(event) => setApiKey(event.target.value)}
          />
        </label>
      )}
      {draft.transport !== 'novelforge-connector' && <details className="ai-provider-manual-details">
        <summary>自定义地址（可选）</summary>
        <div>
          <label className="ai-field">
            <span>完整接口地址</span>
            <input value={draft.endpoint} placeholder={draft.apiStyle === 'gemini' ? 'https://generativelanguage.googleapis.com' : 'https://…/v1/chat/completions'} onChange={(event) => setDraft({ ...draft, endpoint: event.target.value })} />
          </label>
          <details className="ai-provider-advanced">
            <summary>高级选项</summary>
            <label className="ai-field">
              <span>模型上下文上限（token）</span>
              <input
                type="number"
                min={4_000}
                max={10_000_000}
                step={1_000}
                value={draft.contextWindowTokens ?? 16_000}
                onChange={(event) => setDraft({
                  ...draft,
                  contextWindowTokens: Number(event.target.value),
                })}
              />
            </label>
            <label className="ai-field">
              <span>接口格式</span>
              <select value={draft.apiStyle} onChange={(event) => setDraft({
                ...draft,
                apiStyle: event.target.value as AIProviderProfileDraft['apiStyle'],
                authentication: event.target.value === 'gemini' ? 'api-key' : 'bearer',
                memoryToolEnabled: event.target.value === 'openai' ? draft.memoryToolEnabled : false,
              })}>
                <option value="openai">OpenAI 兼容</option>
                <option value="gemini">Google Gemini 原生</option>
              </select>
            </label>
            <label className="ai-provider-tool-toggle">
              <input
                type="checkbox"
                checked={draft.memoryToolEnabled === true}
                disabled={draft.apiStyle !== 'openai'}
                onChange={(event) => setDraft({ ...draft, memoryToolEnabled: event.target.checked })}
              />
              <span>允许 AI 按需查询已保存记忆</span>
            </label>
            <label className="ai-field">
              <span>认证方式</span>
              <select value={draft.authentication} onChange={(event) => setDraft({
                ...draft, authentication: event.target.value as AIProviderProfileDraft['authentication'],
              })}>
                <option value="bearer">Bearer KEY</option>
                <option value="api-key">API KEY 请求头</option>
                <option value="none">不需要 KEY</option>
              </select>
            </label>
          </details>
        </div>
      </details>}
      <div className="ai-provider-actions">
        <button
          type="button"
          className="ai-provider-primary-button"
          disabled={!draft.endpoint.trim() || !draft.model.trim()}
          onClick={saveProfile}
        ><Icon name="save" size={15} />保存连接</button>
        {draft.transport !== 'novelforge-connector' && <IconButton
          icon="trash"
          label="清除当前平台的会话 KEY"
          className="ai-provider-secondary-button ai-provider-secondary-icon-action"
          disabled={!selected?.hasSessionKey}
          onClick={() => draft.id && void run(
            () => client.dispatch('aiProvider.clearSessionKey', { profileId: draft.id }),
            '当前平台 KEY 已清除',
            draft.id,
          )}
        />}
      </div>
      {message && <p className="ai-message">{message}</p>}
      {error && <p className="ai-error" role="alert">{error}</p>}
      </section>
    </section>
  );
}

function profileDraft(profile: AIProviderProfileState): AIProviderProfileDraft {
  return {
    id: profile.id,
    label: profile.label,
    platform: profile.platform,
    endpoint: profile.endpoint,
    model: profile.model,
    transport: profile.transport ?? 'http',
    contextWindowTokens: profile.contextWindowTokens,
    authentication: profile.authentication,
    apiStyle: profile.apiStyle,
    memoryToolEnabled: profile.memoryToolEnabled === true,
    secretPersistence: profile.secretPersistence ?? 'personal-local',
  };
}

function aiDraftForSave(draft: AIProviderProfileDraft, presetId: string): AIProviderProfileDraft {
  const preset = AI_PROVIDER_PRESETS.find((item) => item.id === presetId);
  const platform = preset?.draft.platform || endpointPlatform(draft.endpoint);
  return {
    ...draft,
    platform,
    label: draft.model.trim() || platform,
  };
}

function aiProfileLabel(profile: AIProviderProfileState): string {
  return `${profile.platform} · ${profile.model || '未填写模型'}`;
}

function endpointPlatform(endpoint: string): string {
  try {
    return new URL(endpoint).hostname || '自定义模型';
  } catch {
    return '自定义模型';
  }
}
