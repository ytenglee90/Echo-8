'use client';

import { useCallback, useEffect, useState, useSyncExternalStore } from 'react';
import type { ViewClient } from '../../core/contracts.ts';
import {
  SEMANTIC_PROVIDER_CHANGED_SIGNAL,
  SEMANTIC_PROVIDER_COMMANDS,
  SEMANTIC_PROVIDER_STATE_QUERY,
  type SemanticProviderPanelState,
  type SemanticProviderProfileDraft,
  type SemanticProviderProfileState,
} from '../../protocols/semantic.ts';
import { IconButton } from '../../ui/Icon.tsx';
import {
  applySemanticProviderPreset,
  matchSemanticProviderPreset,
  SEMANTIC_PROVIDER_PRESETS,
} from './semantic-presets.ts';

const EMPTY_DRAFT: SemanticProviderProfileDraft = {
  label: '',
  platform: '',
  endpoint: '',
  model: '',
  apiStyle: 'openai-compatible',
  authentication: 'bearer',
  allowRemoteContent: false,
  maxBatchSize: 32,
};

const EMPTY_STATE: SemanticProviderPanelState = {
  profiles: [],
  cache: { status: 'idle', indexedSources: 0, indexedChunks: 0, totalSources: 0, partialSources: 0 },
};

export function SemanticProviderSettings({ client }: { client: ViewClient }) {
  const commandVersion = useSyncExternalStore(
    client.subscribeCommands,
    client.getCommandVersion,
    () => 0,
  );
  const available = client.isCommandAvailable(SEMANTIC_PROVIDER_COMMANDS.saveProfile);
  const [state, setState] = useState<SemanticProviderPanelState>(EMPTY_STATE);
  const [draft, setDraft] = useState<SemanticProviderProfileDraft>(EMPTY_DRAFT);
  const [apiKey, setApiKey] = useState('');
  const [message, setMessage] = useState('');
  const [error, setError] = useState('');
  const [presetId, setPresetId] = useState('');

  const applyState = useCallback((next: SemanticProviderPanelState, preferredId?: string) => {
    setState(next);
    const selected = next.profiles.find((profile) => profile.id === preferredId) ??
      next.profiles.find((profile) => profile.id === next.activeProfileId);
    setDraft(selected ? profileDraft(selected) : { ...EMPTY_DRAFT });
    setPresetId(selected ? matchSemanticProviderPreset(selected) : '');
  }, []);
  const refresh = useCallback(async (preferredId?: string) => {
    if (!available) return applyState(EMPTY_STATE);
    const next = await client.ask<SemanticProviderPanelState>(SEMANTIC_PROVIDER_STATE_QUERY);
    applyState(next, preferredId);
  }, [applyState, available, client]);

  useEffect(() => {
    if (!available) return undefined;
    let current = true;
    void client.ask<SemanticProviderPanelState>(SEMANTIC_PROVIDER_STATE_QUERY).then((next) => {
      if (current) applyState(next);
    }).catch(() => undefined);
    return () => { current = false; };
  }, [applyState, client, available, commandVersion]);

  useEffect(() => {
    if (!available) return undefined;
    return client.subscribeSignal(SEMANTIC_PROVIDER_CHANGED_SIGNAL, () => {
      void refresh(draft.id).catch(() => undefined);
    });
  }, [client, available, draft.id, refresh]);

  if (!available) {
    return (
      <section className="semantic-provider-settings" aria-label="云端语义检索">
        <div className="semantic-provider-unavailable">
          <strong>云端语义检索未启用</strong>
          <span>本机理解检索和 BM25 仍可正常使用；如需云端模型，可在插件中心启用“远程语义检索”。</span>
        </div>
      </section>
    );
  }

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
    void run(
      () => client.dispatch(SEMANTIC_PROVIDER_COMMANDS.activateProfile, { profileId }),
      '已切换当前语义检索连接',
      profileId,
    );
  };
  const saveProfile = () => {
    const normalized = semanticDraftForSave(draft, presetId);
    void run(async () => {
      const saved = await client.dispatch(SEMANTIC_PROVIDER_COMMANDS.saveProfile, normalized);
      if (normalized.authentication !== 'none' && apiKey.trim()) {
        await client.dispatch(SEMANTIC_PROVIDER_COMMANDS.setSessionKey, {
          profileId: saved.id,
          apiKey,
        });
      }
      setApiKey('');
    }, draft.id ? '语义连接配置已更新' : '语义连接已添加', draft.id);
  };
  const selected = state.profiles.find((profile) => profile.id === draft.id);
  const cacheLabel = semanticCacheLabel(state);

  return (
    <section className="semantic-provider-settings" aria-label="云端语义检索">
      <details>
        <summary>
          <span>
            <strong>云端语义检索（可选）</strong>
            <small>使用云端 Embedding 模型；仅在你同意发送有限资料片段时启用。</small>
          </span>
          <em>{selected?.configured ? '已连接' : '未设置'}</em>
        </summary>
        <div className="semantic-provider-settings-content">
          <p className="panel-copy">它和对话模型互相独立，只负责理解相近说法；连接和 KEY 会进入个人配置，不写入书籍文件。</p>
          <div className="ai-provider-profile-toolbar">
        <select
          aria-label="当前语义检索连接"
          value={draft.id ?? ''}
          onChange={(event) => selectProfile(event.target.value)}
        >
          <option value="" disabled>{state.profiles.length ? '选择语义检索连接' : '还没有语义检索连接'}</option>
          {state.profiles.map((profile) => (
            <option key={profile.id} value={profile.id}>
              {semanticProfileLabel(profile)}{profile.configured ? '' : '（未就绪）'}
            </option>
          ))}
        </select>
        <IconButton
          icon="add"
          label="添加新的语义检索连接"
          onClick={() => {
            setDraft({ ...EMPTY_DRAFT });
            setApiKey('');
            setPresetId('');
            setMessage('正在添加新的语义检索连接');
            setError('');
          }}
        />
        <IconButton
          icon="trash"
          label="删除当前语义检索连接"
          disabled={!draft.id}
          onClick={() => draft.id && void run(
            () => client.dispatch(SEMANTIC_PROVIDER_COMMANDS.removeProfile, { profileId: draft.id }),
            '语义检索连接已删除',
          )}
        />
          </div>

          <div className={`ai-provider-state ${selected?.configured ? 'ready' : ''}`}>
        <i />{selected?.configured ? `当前连接已就绪 · ${cacheLabel}` : draft.id
          ? '还缺少参数、KEY 或远程内容授权'
          : '填写并保存新的语义检索连接'}
          </div>
          <label className="ai-field">
        <span>快速选择语义平台</span>
        <select value={presetId} onChange={(event) => {
          const id = event.target.value;
          setPresetId(id);
          const next = applySemanticProviderPreset(id);
          if (!next) return;
          setDraft(next);
          setApiKey('');
          const preset = SEMANTIC_PROVIDER_PRESETS.find((item) => item.id === id);
          setMessage(`已填入${preset?.label ?? '语义平台'}范本；请核对地址、模型和 KEY`);
          setError('');
        }}>
          <option value="">手动填写 / 选择平台范本</option>
          {SEMANTIC_PROVIDER_PRESETS.map((preset) => (
            <option key={preset.id} value={preset.id} disabled={!preset.available}>{preset.label}</option>
          ))}
        </select>
          </label>
          <label className="ai-field">
        <span>完整接口地址</span>
        <input
          value={draft.endpoint}
          placeholder={draft.apiStyle === 'gemini'
            ? 'https://…/v1beta/models/...:batchEmbedContents'
            : 'https://…/v1/embeddings'}
          onChange={(event) => setDraft({ ...draft, endpoint: event.target.value })}
        />
          </label>
          <label className="ai-field">
        <span>向量模型名称</span>
        <input value={draft.model} placeholder="由对应平台提供" onChange={(event) => setDraft({ ...draft, model: event.target.value })} />
          </label>
          {draft.authentication !== 'none' && (
        <label className="ai-field">
          <span>当前平台 KEY</span>
          <input
            type="password"
            autoComplete="off"
            value={apiKey}
            placeholder={selected?.hasSessionKey ? '当前会话已加载；留空可保持不变' : '绑定个人配置 TXT 后可在本机恢复'}
            onChange={(event) => setApiKey(event.target.value)}
          />
        </label>
          )}
          <details className="ai-provider-advanced">
        <summary>高级连接设置</summary>
        <label className="ai-field">
          <span>接口格式</span>
          <select value={draft.apiStyle} onChange={(event) => {
            const apiStyle = event.target.value as SemanticProviderProfileDraft['apiStyle'];
            setDraft({ ...draft, apiStyle, authentication: apiStyle === 'gemini' ? 'api-key' : 'bearer' });
          }}>
            <option value="openai-compatible">OpenAI Embeddings 兼容</option>
            <option value="voyage">Voyage Embeddings</option>
            <option value="gemini">Gemini Batch Embeddings</option>
          </select>
        </label>
        <label className="ai-field">
          <span>认证方式</span>
          <select value={draft.authentication} onChange={(event) => setDraft({
            ...draft, authentication: event.target.value as SemanticProviderProfileDraft['authentication'],
          })}>
            <option value="bearer">Bearer KEY</option>
            <option value="api-key">API-Key 请求头</option>
            <option value="none">不需要 KEY</option>
          </select>
        </label>
        <label className="ai-field">
          <span>单批片段数量</span>
          <input type="number" min={1} max={100} value={draft.maxBatchSize}
            onChange={(event) => setDraft({ ...draft, maxBatchSize: Math.max(1, Math.min(100, Number(event.target.value) || 1)) })} />
        </label>
          </details>
          <label className="semantic-provider-consent">
        <input
          type="checkbox"
          checked={draft.allowRemoteContent}
          onChange={(event) => setDraft({ ...draft, allowRemoteContent: event.target.checked })}
        />
        <span>允许检索时将有限的画布片段发送到该平台建立临时语义索引。关闭后只使用本地 BM25。</span>
          </label>
          <div className="ai-provider-actions">
        <IconButton
          icon="save"
          label="保存当前语义连接和 KEY"
          className="primary-icon-button ai-provider-save"
          disabled={!draft.endpoint.trim() || !draft.model.trim() || /[{}]/u.test(draft.endpoint)}
          onClick={saveProfile}
        />
        <IconButton
          icon="reset"
          label="重新建立临时语义索引"
          disabled={!selected?.configured}
          onClick={() => void run(
            () => client.dispatch(SEMANTIC_PROVIDER_COMMANDS.rebuild, { force: true }),
            '语义索引重建任务已开始',
            draft.id,
          )}
        />
        <IconButton
          icon="trash"
          label="清除当前平台的会话 KEY"
          disabled={!selected?.hasSessionKey}
          onClick={() => draft.id && void run(
            () => client.dispatch(SEMANTIC_PROVIDER_COMMANDS.clearSessionKey, { profileId: draft.id }),
            '当前语义平台 KEY 已清除',
            draft.id,
          )}
        />
          </div>
          <p className="ai-provider-note">首次检索会建立临时向量索引。没有云端连接时，AI 仍会使用本机理解检索或 BM25。</p>
          {presetId && <p className="ai-provider-note">{SEMANTIC_PROVIDER_PRESETS.find((item) => item.id === presetId)?.note}</p>}
          {message && <p className="ai-message">{message}</p>}
          {error && <p className="ai-error" role="alert">{error}</p>}
        </div>
      </details>
    </section>
  );
}

function semanticDraftForSave(draft: SemanticProviderProfileDraft, presetId: string): SemanticProviderProfileDraft {
  const preset = SEMANTIC_PROVIDER_PRESETS.find((item) => item.id === presetId && item.available);
  const platform = preset?.draft?.platform || endpointPlatform(draft.endpoint);
  return {
    ...draft,
    platform,
    label: draft.model.trim() || platform,
  };
}

function semanticProfileLabel(profile: SemanticProviderProfileState): string {
  return `${profile.platform} · ${profile.model || '未填写模型'}`;
}

function endpointPlatform(endpoint: string): string {
  try {
    return new URL(endpoint).hostname || '自定义语义平台';
  } catch {
    return '自定义语义平台';
  }
}

function profileDraft(profile: SemanticProviderProfileState): SemanticProviderProfileDraft {
  return {
    id: profile.id,
    label: profile.label,
    platform: profile.platform,
    endpoint: profile.endpoint,
    model: profile.model,
    apiStyle: profile.apiStyle,
    authentication: profile.authentication,
    allowRemoteContent: profile.allowRemoteContent,
    maxBatchSize: profile.maxBatchSize,
  };
}

function semanticCacheLabel(state: SemanticProviderPanelState): string {
  const { cache } = state;
  if (cache.status === 'indexing') return `正在建立索引 ${cache.indexedSources}/${cache.totalSources}`;
  if (cache.status === 'ready') return cache.partialSources > 0
    ? `已索引 ${cache.indexedSources} 个来源，${cache.partialSources} 个超长来源为分段覆盖`
    : `已索引 ${cache.indexedSources} 个来源`;
  if (cache.status === 'dirty') return '内容已变化，下次检索增量更新';
  if (cache.status === 'error') return '索引失败，已回退 BM25';
  return '首次检索时建立临时索引';
}
