import { createId, isRecord, type PluginDefinition } from '../../core/contracts.ts';
import type {
  AIGenerateRequest,
  AIGenerateResult,
  AIGenerateStream,
  AIProviderCatalog,
  AIProviderInfo,
} from '../../protocols/ai.ts';
import type { FileReadWriteTarget } from '../../protocols/files.ts';
import { canReusePersistedFileHandle } from '../../services/native-file-permission.ts';
import { defineManifest } from '../manifest.ts';
import {
  SEMANTIC_PROVIDER_CHANGED_SIGNAL,
  SEMANTIC_PROVIDER_COMMANDS,
  SEMANTIC_PROVIDER_PERSONAL_QUERY,
  SEMANTIC_PROVIDER_STATE_QUERY,
  type SemanticAPIStyle,
  type SemanticAuthentication,
  type SemanticProviderPersonalConnections,
  type SemanticProviderProfile,
} from '../../protocols/semantic.ts';
import type {
  AIProviderConfiguration,
  AIProviderPanelState,
  AIProviderPreferences,
  AIProviderProfile,
  AIProviderProfileDraft,
  AIProviderProfileState,
} from './types.ts';
import {
  buildProviderRequest,
  fetchWithInitialRetry,
  parseCompletion,
  parseGeminiCompletion,
  readCompletionEvents,
  readLimitedJson,
  validateGenerateRequest,
  webSearchCatalogFields,
} from './provider-transport.ts';

export const AI_PROVIDER_NAMESPACE = 'aiProvider';
const DEFAULT_PREFERENCES: AIProviderPreferences = {
  endpoint: '', model: '', contextWindowTokens: 16_000, authentication: 'bearer', apiStyle: 'openai',
  memoryToolEnabled: false, secretPersistence: 'personal-local',
};
const PERSONAL_CONNECTIONS_KEY = 'connections-and-keys@1';
const PERSONAL_BACKUP_HANDLE_KEY = 'ai-personal-backup-handle@1';
const MAX_PERSONAL_BACKUP_CHARACTERS = 2 * 1024 * 1024;

interface PersonalConnections {
  configuration: AIProviderConfiguration;
  apiKeys: Record<string, string>;
}

interface PersonalAIBackup {
  provider: PersonalConnections;
  semantic?: SemanticProviderPersonalConnections;
}

interface ProfileIdPayload {
  profileId?: string;
}

interface SessionKeyPayload extends ProfileIdPayload {
  apiKey: string;
}

export function createAIProviderPlugin(panel?: unknown, semanticPanel?: unknown): PluginDefinition {
  const sessionApiKeys = new Map<string, string>();
  const activeRequests = new Set<AbortController>();
  let personalBackupHandle: FileReadWriteTarget | undefined;
  let lastSemanticConnections: SemanticProviderPersonalConnections | undefined;
  let backupWriteTail: Promise<void> = Promise.resolve();
  return {
    manifest: defineManifest('ai-provider', 'AI 模型连接', {
      category: 'provider',
      namespaces: [AI_PROVIDER_NAMESPACE],
      namespaceDomains: { [AI_PROVIDER_NAMESPACE]: 'workspace' },
      commands: [
        'aiProvider.setPreferences',
        'aiProvider.profile.save',
        'aiProvider.profile.remove',
        'aiProvider.profile.activate',
        'aiProvider.setSessionKey',
        'aiProvider.clearSessionKey',
        'aiProvider.restorePersonal',
        'aiProvider.personalBackup.bind',
        'aiProvider.personalBackup.import',
        'aiProvider.personalBackup.sync',
      ],
      dispatches: [
        ...Object.values(SEMANTIC_PROVIDER_COMMANDS),
        'aiProvider.restorePersonal',
        'system.preferences.set',
      ],
      events: ['ai.provider.configuration.changed'],
      signals: ['ai.provider.changed', SEMANTIC_PROVIDER_CHANGED_SIGNAL],
      queries: ['aiProvider.state'],
      asks: [
        'aiProvider.state',
        SEMANTIC_PROVIDER_STATE_QUERY,
        SEMANTIC_PROVIDER_PERSONAL_QUERY,
        'system.preferences.get',
      ],
      providesCapabilities: ['ai.generate@1', 'ai.generate.stream@1', 'ai.provider.info@1', 'ai.provider.catalog@1'],
      ui: ['ai-provider.settings', 'ai-provider.semantic-settings'],
      permissions: [
        'store.own.read',
        'store.own.write',
        'ui.ai-settings.contribute',
        'network.ai.generate',
        'network.origin.manage',
        'preferences.manage',
      ],
    }),

    start(context) {
      sessionApiKeys.clear();
      lastSemanticConnections = undefined;
      backupWriteTail = Promise.resolve();
      const readConfiguration = (): AIProviderConfiguration => {
        const stored = normalizeConfiguration(
          context.store.readValue(AI_PROVIDER_NAMESPACE, 'configuration'),
        );
        if (stored.profiles.length > 0) return stored;
        const legacy = normalizePreferences(context.store.readValue(AI_PROVIDER_NAMESPACE, 'preferences'));
        if (!legacy.endpoint && !legacy.model) return stored;
        const profile: AIProviderProfile = {
          id: 'legacy-default',
          label: '默认连接',
          platform: 'OpenAI 兼容',
          ...legacy,
        };
        return { profiles: [profile], activeProfileId: profile.id };
      };
      const activeProfile = (configuration = readConfiguration()): AIProviderProfile | undefined =>
        configuration.profiles.find((profile) => profile.id === configuration.activeProfileId) ??
        configuration.profiles[0];
      const syncApprovedOrigins = (configuration = readConfiguration()) => {
        context.network.configureOrigins(configuration.profiles.map((profile) => profile.endpoint));
      };
      syncApprovedOrigins();
      const profileState = (profile: AIProviderProfile): AIProviderProfileState => {
        const hasSessionKey = Boolean(sessionApiKeys.get(profile.id));
        return {
          ...profile,
          hasSessionKey,
          configured: isConfigured(profile, hasSessionKey),
        };
      };
      const readState = (): AIProviderPanelState => {
        const configuration = readConfiguration();
        const active = activeProfile(configuration);
        const activeState = active ? profileState(active) : undefined;
        return {
          ...(active ?? DEFAULT_PREFERENCES),
          activeProfileId: active?.id,
          profiles: configuration.profiles.map(profileState),
          hasSessionKey: activeState?.hasSessionKey ?? false,
          configured: activeState?.configured ?? false,
          personalBackupName: personalBackupHandle?.name,
        };
      };
      const personalConnectionsPayload = () => ({
        key: PERSONAL_CONNECTIONS_KEY,
        value: {
          configuration: readConfiguration(),
          apiKeys: persistableApiKeys(readConfiguration(), sessionApiKeys),
        } satisfies PersonalConnections,
      });
      const persistPersonal = () => context.commands.dispatch('system.preferences.set', personalConnectionsPayload());
      const deferPersonalPersistence = () => context.commands.defer(
        'system.preferences.set',
        personalConnectionsPayload(),
      );
      const writePersonalBackupNow = async () => {
        if (!personalBackupHandle) return { saved: false, reason: 'unbound' as const };
        const semantic = await context.queries.ask<SemanticProviderPersonalConnections>(
          SEMANTIC_PROVIDER_PERSONAL_QUERY,
        ).then((value) => {
          lastSemanticConnections = value;
          return value;
        }).catch(() => lastSemanticConnections);
        const backup: PersonalAIBackup = {
          provider: {
            configuration: readConfiguration(),
            apiKeys: persistableApiKeys(readConfiguration(), sessionApiKeys),
          },
          semantic,
        };
        const writable = await personalBackupHandle.createWritable();
        try {
          await writable.write(new Blob([serializePersonalAIBackup(backup)], { type: 'text/plain;charset=utf-8' }));
          await writable.close();
        } catch (error) {
          await writable.abort?.().catch(() => undefined);
          throw error;
        }
        return { saved: true, name: personalBackupHandle.name };
      };
      const writePersonalBackup = () => {
        const operation = backupWriteTail.catch(() => undefined).then(writePersonalBackupNow);
        backupWriteTail = operation.then(() => undefined, () => undefined);
        return operation;
      };
      const bindPersonalBackup = async (handle: FileReadWriteTarget) => {
        personalBackupHandle = handle;
        await context.commands.invoke('system.preferences.set', {
          key: PERSONAL_BACKUP_HANDLE_KEY,
          value: handle,
        });
        return {
          result: await writePersonalBackup(),
          transaction: {
            label: '绑定 AI 个人配置备份',
            history: false,
            patches: [{
              op: 'set' as const,
              domain: 'workspace' as const,
              namespace: AI_PROVIDER_NAMESPACE,
              key: 'personalBackupName',
              value: handle.name,
            }],
          },
        };
      };
      const setConfiguration = (
        label: string,
        configuration: AIProviderConfiguration,
        eventPayload: Record<string, unknown>,
      ) => ({
        transaction: {
          label,
          history: false,
          patches: [{
            op: 'set' as const,
            domain: 'workspace' as const,
            namespace: AI_PROVIDER_NAMESPACE,
            key: 'configuration',
            value: configuration,
          }],
          events: [{ type: 'ai.provider.configuration.changed', payload: eventPayload }],
        },
      });

      context.commands.register<AIProviderPreferences, AIProviderPreferences>({
        type: 'aiProvider.setPreferences',
        validate: isPreferences,
        handle: (payload) => {
          const preferences = validatePreferences(payload);
          const configuration = readConfiguration();
          const current = activeProfile(configuration);
          const profile: AIProviderProfile = {
            id: current?.id ?? 'default',
            label: current?.label ?? '默认连接',
            platform: current?.platform ?? 'OpenAI 兼容',
            ...preferences,
          };
          const profiles = current
            ? configuration.profiles.map((candidate) => candidate.id === current.id ? profile : candidate)
            : [...configuration.profiles, profile];
          return {
            result: preferences,
            ...setConfiguration(
              '修改 AI 模型连接',
              { profiles, activeProfileId: profile.id },
              { profileId: profile.id, action: 'save' },
            ),
          };
        },
      });
      context.commands.register({
        type: 'aiProvider.profile.save',
        validate: isProfileDraft,
        handle: (payload) => {
          const configuration = readConfiguration();
          const profile = validateProfile(payload, payload.id?.trim() || createId('ai-provider-profile'));
          const exists = configuration.profiles.some((candidate) => candidate.id === profile.id);
          const profiles = exists
            ? configuration.profiles.map((candidate) => candidate.id === profile.id ? profile : candidate)
            : [...configuration.profiles, profile];
          return {
            result: { id: profile.id },
            ...setConfiguration(
              exists ? '修改 AI 平台连接' : '添加 AI 平台连接',
              { profiles, activeProfileId: profile.id },
              { profileId: profile.id, action: 'save' },
            ),
          };
        },
      });
      context.commands.register<{ profileId: string }>({
        type: 'aiProvider.profile.remove',
        validate: isRequiredProfileId,
        handle: (payload) => {
          const configuration = readConfiguration();
          if (!configuration.profiles.some((profile) => profile.id === payload.profileId)) {
            throw new Error('要删除的模型连接已经不存在');
          }
          const profiles = configuration.profiles.filter((profile) => profile.id !== payload.profileId);
          const nextActive = configuration.activeProfileId === payload.profileId
            ? profiles[0]?.id
            : configuration.activeProfileId;
          return setConfiguration(
            '删除 AI 平台连接',
            { profiles, activeProfileId: nextActive },
            { profileId: payload.profileId, action: 'remove' },
          );
        },
      });
      context.commands.register<{ profileId: string }>({
        type: 'aiProvider.profile.activate',
        validate: isRequiredProfileId,
        handle: (payload) => {
          const configuration = readConfiguration();
          if (!configuration.profiles.some((profile) => profile.id === payload.profileId)) {
            throw new Error('要启用的模型连接已经不存在');
          }
          return setConfiguration(
            '切换 AI 平台连接',
            { ...configuration, activeProfileId: payload.profileId },
            { profileId: payload.profileId, action: 'activate' },
          );
        },
      });
      context.commands.register<SessionKeyPayload, { configured: boolean }>({
        type: 'aiProvider.setSessionKey',
        validate: isSessionKeyPayload,
        handle: (payload) => {
          const configuration = readConfiguration();
          const profile = resolveProfile(configuration, payload.profileId);
          if (!profile) throw new Error('请先保存一个模型连接');
          sessionApiKeys.set(profile.id, payload.apiKey.trim());
          deferPersonalPersistence();
          void writePersonalBackup().catch((error) => context.diagnostics.warn('同步 AI 个人配置 TXT 失败', error));
          context.signals.emit('ai.provider.changed', { profileId: profile.id, reason: 'key' });
          return { result: { configured: isConfigured(profile, Boolean(sessionApiKeys.get(profile.id))) } };
        },
      });
      context.commands.register<ProfileIdPayload>({
        type: 'aiProvider.clearSessionKey',
        validate: isOptionalProfileId,
        handle: (payload = {}) => {
          const profile = resolveProfile(readConfiguration(), payload.profileId);
          if (profile) sessionApiKeys.delete(profile.id);
          deferPersonalPersistence();
          void writePersonalBackup().catch((error) => context.diagnostics.warn('同步 AI 个人配置 TXT 失败', error));
          context.signals.emit('ai.provider.changed', { profileId: profile?.id, reason: 'key' });
          return { result: { configured: false } };
        },
      });
      context.commands.register<PersonalConnections>({
        type: 'aiProvider.restorePersonal',
        validate: isPersonalConnections,
        handle: (payload) => {
          const configuration = normalizeConfiguration(payload.configuration);
          sessionApiKeys.clear();
          for (const [profileId, apiKey] of Object.entries(payload.apiKeys)) {
            const profile = configuration.profiles.find((candidate) => candidate.id === profileId);
            if (apiKey && profile?.secretPersistence !== 'session-only') {
              sessionApiKeys.set(profileId, apiKey);
            }
          }
          return setConfiguration(
            '恢复本机 AI 连接',
            configuration,
            { action: 'restore' },
          );
        },
      });
      context.commands.register<{ handle: FileReadWriteTarget }>({
        type: 'aiProvider.personalBackup.bind',
        validate: isBackupHandlePayload,
        handle: (payload) => bindPersonalBackup(payload.handle),
      });
      context.commands.register<{ handle: FileReadWriteTarget }>({
        type: 'aiProvider.personalBackup.import',
        validate: isBackupHandlePayload,
        handle: async (payload) => {
          const file = await payload.handle.getFile();
          const parsed = parsePersonalAIBackup(await file.text());
          if (parsed.semantic) {
            lastSemanticConnections = parsed.semantic;
            await context.commands.invoke(SEMANTIC_PROVIDER_COMMANDS.restorePersonal, parsed.semantic);
          }
          await context.commands.invoke('aiProvider.restorePersonal', parsed.provider);
          return bindPersonalBackup(payload.handle);
        },
      });
      context.commands.register({
        type: 'aiProvider.personalBackup.sync',
        handle: async () => ({ result: await writePersonalBackup() }),
      });
      context.queries.register({ type: 'aiProvider.state', handle: readState });

      context.capabilities.provide<undefined, AIProviderInfo>({
        key: 'ai.provider.info@1',
        invoke: () => {
          const state = readState();
          const active = state.profiles.find((profile) => profile.id === state.activeProfileId);
          return {
            id: active?.id ?? 'openai-compatible-session',
            label: active ? `${active.platform} · ${active.label}` : '尚未配置模型连接',
            configured: state.configured,
            endpoint: active?.endpoint || undefined,
            model: active?.model || undefined,
            contextWindowTokens: active?.contextWindowTokens,
            secretPersistence: active?.secretPersistence ?? 'personal-local',
          };
        },
      });
      context.capabilities.provide<undefined, AIProviderCatalog>({
        key: 'ai.provider.catalog@1',
        invoke: () => {
          const state = readState();
          return {
            activeId: state.activeProfileId,
            options: state.profiles.map((profile) => ({
              ...webSearchCatalogFields(profile),
              id: profile.id,
              label: profile.label,
              platform: profile.platform,
              model: profile.model,
              contextWindowTokens: profile.contextWindowTokens,
              configured: profile.configured,
              toolCallingSupported: profile.apiStyle === 'openai' && profile.memoryToolEnabled === true,
            })),
          };
        },
      });
      context.capabilities.provide<AIGenerateRequest, AIGenerateResult>({
        key: 'ai.generate@1',
        invoke: async (input, signal) => {
          validateGenerateRequest(input);
          const profile = input.providerId
            ? resolveProfile(readConfiguration(), input.providerId)
            : activeProfile();
          if (!profile || !isConfigured(profile, Boolean(sessionApiKeys.get(profile.id)))) {
            throw new Error('AI 模型连接尚未配置');
          }
          const apiKey = sessionApiKeys.get(profile.id) ?? '';
          const controller = new AbortController();
          activeRequests.add(controller);
          const abort = () => controller.abort();
          signal?.addEventListener('abort', abort, { once: true });
          try {
            const request = buildProviderRequest(profile, apiKey, input, false);
            const response = await fetchWithInitialRetry(
              context.network.fetch,
              request.endpoint,
              { ...request.init, signal: controller.signal },
              controller.signal,
            );
            const payload = await readLimitedJson(response);
            const parsed = profile.apiStyle === 'gemini'
              ? parseGeminiCompletion(payload)
              : parseCompletion(payload);
            return { ...parsed, provider: profile.id, model: profile.model };
          } finally {
            signal?.removeEventListener('abort', abort);
            activeRequests.delete(controller);
          }
        },
      });
      context.capabilities.provide<AIGenerateRequest, AIGenerateStream>({
        key: 'ai.generate.stream@1',
        invoke: async (input, signal) => {
          validateGenerateRequest(input);
          const profile = input.providerId
            ? resolveProfile(readConfiguration(), input.providerId)
            : activeProfile();
          if (!profile || !isConfigured(profile, Boolean(sessionApiKeys.get(profile.id)))) {
            throw new Error('AI 模型连接尚未配置');
          }
          const apiKey = sessionApiKeys.get(profile.id) ?? '';
          const controller = new AbortController();
          activeRequests.add(controller);
          const abort = () => controller.abort();
          const release = () => {
            signal?.removeEventListener('abort', abort);
            activeRequests.delete(controller);
          };
          signal?.addEventListener('abort', abort, { once: true });
          try {
            const request = buildProviderRequest(profile, apiKey, input, true);
            const response = await fetchWithInitialRetry(
              context.network.fetch,
              request.endpoint,
              { ...request.init, signal: controller.signal },
              controller.signal,
            );
            return {
              provider: profile.id,
              model: profile.model,
              events: readCompletionEvents(response, release, profile.apiStyle),
            };
          } catch (error) {
            release();
            throw error;
          }
        },
      });

      context.events.subscribe<{ profileId?: string; action?: string }>(
        'ai.provider.configuration.changed',
        (message) => {
          syncApprovedOrigins();
          if (message.payload.action === 'remove' && message.payload.profileId) {
            sessionApiKeys.delete(message.payload.profileId);
          }
          if (message.payload.action !== 'restore') {
            void persistPersonal().catch((error) => context.diagnostics.warn('保存本机 AI 连接失败', error));
          }
          void writePersonalBackup().catch((error) => context.diagnostics.warn('同步 AI 个人配置 TXT 失败', error));
          context.signals.emit('ai.provider.changed', message.payload);
        },
      );
      context.signals.subscribe(SEMANTIC_PROVIDER_CHANGED_SIGNAL, () => {
        void writePersonalBackup().catch((error) => context.diagnostics.warn('同步 AI 个人配置 TXT 失败', error));
      });

      context.ui.contribute({
        id: 'ai-provider.settings',
        slot: 'ai.settings',
        kind: 'view',
        label: 'AI 模型连接',
        component: panel,
        // The conversation connection is the first task on this page.
        priority: 84,
      });
      if (semanticPanel) {
        context.ui.contribute({
          id: 'ai-provider.semantic-settings',
          slot: 'ai.retrieval',
          kind: 'view',
          label: '云端语义检索',
          component: semanticPanel,
          // Keep the optional remote alternative directly below the local
          // retrieval choice.
          priority: 85.5,
        });
      }
      void context.queries.ask<unknown>('system.preferences.get', { key: PERSONAL_CONNECTIONS_KEY })
        .then((value) => {
          if (isPersonalConnections(value)) {
            return context.commands.dispatch('aiProvider.restorePersonal', value);
          }
          return undefined;
        })
        .catch((error) => context.diagnostics.warn('读取本机 AI 连接失败', error));
      void context.queries.ask<unknown>('system.preferences.get', { key: PERSONAL_BACKUP_HANDLE_KEY })
        .then(async (value) => {
          if (!isFileReadWriteTarget(value)) return;
          // A restored handle can be present while its browser permission is
          // merely "prompt". Never turn application startup into an implicit
          // file access request: IndexedDB already owns the authoritative
          // personal connection cache. The user can explicitly rebind/import
          // the TXT when another browser or machine needs it.
          if (!await canReusePersistedFileHandle(value)) return;
          personalBackupHandle = value;
        })
        .catch((error) => context.diagnostics.warn('读取 AI 个人配置文件绑定失败', error));
    },

    stop() {
      personalBackupHandle = undefined;
      lastSemanticConnections = undefined;
      backupWriteTail = Promise.resolve();
      sessionApiKeys.clear();
      for (const controller of activeRequests) controller.abort();
      activeRequests.clear();
    },
  };
}

function isFileReadWriteTarget(value: unknown): value is FileReadWriteTarget {
  return isRecord(value) && typeof value.name === 'string' &&
    typeof value.createWritable === 'function' && typeof value.getFile === 'function';
}

function isBackupHandlePayload(value: unknown): value is { handle: FileReadWriteTarget } {
  return isRecord(value) && isFileReadWriteTarget(value.handle);
}

function serializePersonalAIBackup(backup: PersonalAIBackup): string {
  const activeProfileId = backup.provider.configuration.activeProfileId;
  const profiles = [...backup.provider.configuration.profiles].sort((left, right) =>
    Number(right.id === activeProfileId) - Number(left.id === activeProfileId));
  const activeSemanticProfileId = backup.semantic?.configuration.activeProfileId;
  const semanticProfiles = [...(backup.semantic?.configuration.profiles ?? [])].sort((left, right) =>
    Number(right.id === activeSemanticProfileId) - Number(left.id === activeSemanticProfileId));
  const sections = [
    ...profiles.map((profile) => [
      '【模型连接】',
      `平台名称：${oneLine(profile.platform)}`,
      `连接名称：${oneLine(profile.label)}`,
      `接口格式：${profile.apiStyle === 'gemini' ? 'Google Gemini 原生' : 'OpenAI 兼容'}`,
      `完整接口地址：${oneLine(profile.endpoint)}`,
      `模型名称：${oneLine(profile.model)}`,
      `模型上下文上限：${profile.contextWindowTokens ?? 16_000}`,
      `允许按需记忆工具：${profile.memoryToolEnabled === true ? '是' : '否'}`,
      `密钥保存：${profile.secretPersistence === 'session-only' ? '仅当前会话' : '本机个人配置'}`,
      `认证方式：${authenticationLabel(profile.authentication)}`,
      `当前平台 KEY：${oneLine(backup.provider.apiKeys[profile.id] ?? '')}`,
    ].join('\n')),
    ...semanticProfiles.map((profile) => [
      '【语义检索连接】',
      `平台名称：${oneLine(profile.platform)}`,
      `连接名称：${oneLine(profile.label)}`,
      `接口格式：${semanticAPIStyleLabel(profile.apiStyle)}`,
      `完整接口地址：${oneLine(profile.endpoint)}`,
      `模型名称：${oneLine(profile.model)}`,
      `认证方式：${semanticAuthenticationLabel(profile.authentication)}`,
      `允许发送画布片段：${profile.allowRemoteContent ? '是' : '否'}`,
      `单批片段数量：${profile.maxBatchSize}`,
      `当前平台 KEY：${oneLine(backup.semantic?.apiKeys[profile.id] ?? '')}`,
    ].join('\n')),
  ];
  return `${sections.join('\n\n')}\n`;
}

function parsePersonalAIBackup(text: string): PersonalAIBackup {
  const normalized = text.replace(/^\uFEFF/u, '').replace(/\r\n?/gu, '\n');
  if (!normalized.trim() || normalized.length > MAX_PERSONAL_BACKUP_CHARACTERS) {
    throw new Error('AI 个人配置 TXT 为空或超过 2 MB');
  }
  const markers = [...normalized.matchAll(/^【(模型连接|语义检索连接|Prompt 模板)】\s*$/gmu)];
  if (markers.length === 0) throw new Error('AI 个人配置 TXT 缺少模型或语义检索连接');
  const profiles: AIProviderProfile[] = [];
  const apiKeys: Record<string, string> = {};
  const semanticProfiles: SemanticProviderProfile[] = [];
  const semanticApiKeys: Record<string, string> = {};
  for (let index = 0; index < markers.length; index += 1) {
    const marker = markers[index];
    const body = normalized.slice((marker.index ?? 0) + marker[0].length, markers[index + 1]?.index ?? normalized.length)
      .replace(/^\n/u, '').replace(/\n+$/u, '');
    if (marker[1] === '模型连接') {
      if (profiles.length >= 24) throw new Error('模型连接不能超过 24 个');
      const id = createId('ai-provider-profile');
      const profile = validateProfile({
        platform: readBackupLine(body, '平台名称'),
        label: readBackupLine(body, '连接名称'),
        endpoint: readBackupLine(body, '完整接口地址', false),
        model: readBackupLine(body, '模型名称', false),
        contextWindowTokens: parseContextWindowTokens(readBackupLine(body, '模型上下文上限', false)),
        memoryToolEnabled: readBackupLine(body, '允许按需记忆工具', false) === '是',
        secretPersistence: readBackupLine(body, '密钥保存', false) === '仅当前会话'
          ? 'session-only'
          : 'personal-local',
        apiStyle: readBackupLine(body, '接口格式') === 'Google Gemini 原生' ? 'gemini' : 'openai',
        authentication: parseAuthentication(readBackupLine(body, '认证方式')),
      }, id);
      profiles.push(profile);
      const apiKey = readBackupLine(body, '当前平台 KEY', false);
      if (apiKey) apiKeys[id] = apiKey;
      continue;
    }
    if (marker[1] === 'Prompt 模板') continue;
    if (semanticProfiles.length >= 24) throw new Error('语义检索连接不能超过 24 个');
    const id = createId('semantic-provider-profile');
    const maxBatchSize = Number(readBackupLine(body, '单批片段数量'));
    if (!Number.isInteger(maxBatchSize) || maxBatchSize < 1 || maxBatchSize > 100) {
      throw new Error('语义检索连接的单批片段数量必须在 1 到 100 之间');
    }
    const profile = validateSemanticBackupProfile({
      id,
      platform: readBackupLine(body, '平台名称'),
      label: readBackupLine(body, '连接名称'),
      endpoint: readBackupLine(body, '完整接口地址', false),
      model: readBackupLine(body, '模型名称', false),
      apiStyle: parseSemanticAPIStyle(readBackupLine(body, '接口格式')),
      authentication: parseSemanticAuthentication(readBackupLine(body, '认证方式')),
      allowRemoteContent: readBackupLine(body, '允许发送画布片段') === '是',
      maxBatchSize,
    });
    semanticProfiles.push(profile);
    const apiKey = readBackupLine(body, '当前平台 KEY', false);
    if (apiKey) semanticApiKeys[id] = apiKey;
  }
  if (profiles.length === 0 && semanticProfiles.length === 0) {
    throw new Error('AI 个人配置 TXT 没有可导入的连接');
  }
  return {
    provider: {
      configuration: { profiles, activeProfileId: profiles[0]?.id },
      apiKeys,
    },
    semantic: semanticProfiles.length > 0 ? {
      configuration: { profiles: semanticProfiles, activeProfileId: semanticProfiles[0]?.id },
      apiKeys: semanticApiKeys,
    } : undefined,
  };
}

function semanticAPIStyleLabel(value: SemanticAPIStyle): string {
  if (value === 'gemini') return 'Google Gemini 原生';
  if (value === 'voyage') return 'Voyage Embeddings';
  return 'OpenAI Embeddings 兼容';
}

function parseSemanticAPIStyle(value: string): SemanticAPIStyle {
  if (value === 'Google Gemini 原生') return 'gemini';
  if (value === 'Voyage Embeddings') return 'voyage';
  return 'openai-compatible';
}

function semanticAuthenticationLabel(value: SemanticAuthentication): string {
  if (value === 'api-key') return 'API KEY 请求头';
  if (value === 'none') return '不需要 KEY';
  return 'Bearer 会话 KEY';
}

function parseSemanticAuthentication(value: string): SemanticAuthentication {
  if (value === 'API KEY 请求头') return 'api-key';
  if (value === '不需要 KEY') return 'none';
  return 'bearer';
}

function validateSemanticBackupProfile(profile: SemanticProviderProfile): SemanticProviderProfile {
  if (!profile.id || profile.id.length > 160 || !profile.label.trim() || !profile.platform.trim() ||
    profile.label.length > 120 || profile.platform.length > 120 || profile.endpoint.length > 2048 ||
    profile.model.length > 200) throw new Error('语义检索连接内容不完整或过长');
  if (profile.endpoint) {
    const url = new URL(profile.endpoint, typeof location === 'undefined' ? 'http://localhost' : location.origin);
    if (!['http:', 'https:'].includes(url.protocol)) throw new Error('语义接口只支持 HTTP 或 HTTPS');
  }
  return {
    ...profile,
    label: profile.label.trim(),
    platform: profile.platform.trim(),
    endpoint: profile.endpoint.trim(),
    model: profile.model.trim(),
  };
}

function readBackupLine(body: string, label: string, required = true): string {
  const escaped = label.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&');
  const match = new RegExp(`^${escaped}：(.*)$`, 'mu').exec(body);
  const value = match?.[1]?.trim() ?? '';
  if (required && !value) throw new Error(`AI 个人配置 TXT 缺少“${label}”`);
  return value;
}

function oneLine(value: string): string {
  return value.replace(/[\r\n]+/gu, ' ').trim();
}

function authenticationLabel(value: AIProviderPreferences['authentication']): string {
  return value === 'api-key' ? 'API KEY 请求头（Gemini）' : value === 'none' ? '不需要 KEY' : 'Bearer 会话 KEY';
}

function parseAuthentication(value: string): AIProviderPreferences['authentication'] {
  if (value === 'API KEY 请求头（Gemini）') return 'api-key';
  if (value === '不需要 KEY') return 'none';
  return 'bearer';
}

function normalizeConfiguration(value: unknown): AIProviderConfiguration {
  if (!isRecord(value) || !Array.isArray(value.profiles)) return { profiles: [] };
  const profiles: AIProviderProfile[] = [];
  const ids = new Set<string>();
  for (const candidate of value.profiles) {
    if (!isProfile(candidate) || ids.has(candidate.id)) continue;
    try {
      const profile = validateProfile(candidate, candidate.id);
      profiles.push(profile);
      ids.add(profile.id);
    } catch {
      // Invalid personal connections are omitted without affecting document data.
    }
  }
  const activeProfileId = typeof value.activeProfileId === 'string' && ids.has(value.activeProfileId)
    ? value.activeProfileId
    : profiles[0]?.id;
  return { profiles, activeProfileId };
}

function normalizePreferences(value: unknown): AIProviderPreferences {
  if (!isPreferences(value)) return { ...DEFAULT_PREFERENCES };
  try {
    return validatePreferences(value);
  } catch {
    return { ...DEFAULT_PREFERENCES };
  }
}

function isPreferences(value: unknown): value is AIProviderPreferences {
  return isRecord(value) && typeof value.endpoint === 'string' && typeof value.model === 'string' &&
    (value.contextWindowTokens === undefined || (Number.isInteger(value.contextWindowTokens) &&
      Number(value.contextWindowTokens) >= 4_000 && Number(value.contextWindowTokens) <= 10_000_000)) &&
    (value.authentication === 'bearer' || value.authentication === 'api-key' || value.authentication === 'none') &&
    (value.apiStyle === undefined || value.apiStyle === 'openai' || value.apiStyle === 'gemini') &&
    (value.memoryToolEnabled === undefined || typeof value.memoryToolEnabled === 'boolean') &&
    (value.secretPersistence === undefined || value.secretPersistence === 'personal-local' ||
      value.secretPersistence === 'session-only');
}

function isProfile(value: unknown): value is AIProviderProfile {
  if (!isRecord(value) || !isPreferences(value)) return false;
  const record: Record<string, unknown> = value;
  return typeof record.id === 'string' && typeof record.label === 'string' &&
    typeof record.platform === 'string';
}

function isProfileDraft(value: unknown): value is AIProviderProfileDraft {
  if (!isRecord(value) || !isPreferences(value)) return false;
  const record: Record<string, unknown> = value;
  return (record.id === undefined || typeof record.id === 'string') &&
    typeof record.label === 'string' && typeof record.platform === 'string';
}

function validatePreferences(value: AIProviderPreferences): AIProviderPreferences {
  const endpoint = value.endpoint.trim();
  const model = value.model.trim();
  if (endpoint.length > 2048 || model.length > 200) throw new Error('模型连接配置过长');
  if (endpoint) {
    const url = new URL(endpoint, typeof location === 'undefined' ? 'http://localhost' : location.origin);
    if (url.protocol !== 'http:' && url.protocol !== 'https:') throw new Error('模型接口只支持 HTTP 或 HTTPS');
  }
  const apiStyle = value.apiStyle ?? (/generativelanguage\.googleapis\.com/iu.test(endpoint) ? 'gemini' : 'openai');
  const contextWindowTokens = value.contextWindowTokens ?? 16_000;
  if (!Number.isInteger(contextWindowTokens) || contextWindowTokens < 4_000 || contextWindowTokens > 10_000_000) {
    throw new Error('模型上下文上限必须是 4,000 到 10,000,000 之间的整数');
  }
  return {
    endpoint,
    model,
    contextWindowTokens,
    authentication: value.authentication,
    apiStyle,
    memoryToolEnabled: apiStyle === 'openai' && value.memoryToolEnabled === true,
    secretPersistence: value.secretPersistence ?? 'personal-local',
  };
}

function persistableApiKeys(
  configuration: AIProviderConfiguration,
  sessionApiKeys: Map<string, string>,
): Record<string, string> {
  const persistableIds = new Set(
    configuration.profiles
      .filter((profile) => profile.secretPersistence !== 'session-only')
      .map((profile) => profile.id),
  );
  return Object.fromEntries(
    [...sessionApiKeys].filter(([profileId]) => persistableIds.has(profileId)),
  );
}

function parseContextWindowTokens(value: string): number {
  if (!value) return 16_000;
  const parsed = Number(value.replace(/[,，\s]/gu, ''));
  if (!Number.isInteger(parsed) || parsed < 4_000 || parsed > 10_000_000) {
    throw new Error('AI 个人配置 TXT 的模型上下文上限不正确');
  }
  return parsed;
}

function validateProfile(value: AIProviderProfileDraft, id: string): AIProviderProfile {
  const label = value.label.trim();
  const platform = value.platform.trim();
  if (!id || id.length > 160 || !label || !platform || label.length > 120 || platform.length > 120) {
    throw new Error('平台和连接名称不能为空，且不能超过 120 个字符');
  }
  return { id, label, platform, ...validatePreferences(value) };
}

function resolveProfile(
  configuration: AIProviderConfiguration,
  profileId?: string,
): AIProviderProfile | undefined {
  return configuration.profiles.find((profile) => profile.id === profileId) ??
    configuration.profiles.find((profile) => profile.id === configuration.activeProfileId) ??
    configuration.profiles[0];
}

function isConfigured(profile: AIProviderProfile, hasSessionKey: boolean): boolean {
  return Boolean(profile.endpoint && profile.model && (profile.authentication === 'none' || hasSessionKey));
}

function isPersonalConnections(value: unknown): value is PersonalConnections {
  return isRecord(value) && isRecord(value.configuration) && isRecord(value.apiKeys) &&
    Object.entries(value.apiKeys).every(([profileId, apiKey]) =>
      profileId.length <= 200 && typeof apiKey === 'string' && apiKey.length <= 4096);
}

function isRequiredProfileId(value: unknown): value is { profileId: string } {
  return isRecord(value) && typeof value.profileId === 'string' && value.profileId.length > 0;
}

function isOptionalProfileId(value: unknown): value is ProfileIdPayload {
  return value === undefined || (isRecord(value) &&
    (value.profileId === undefined || typeof value.profileId === 'string'));
}

function isSessionKeyPayload(value: unknown): value is SessionKeyPayload {
  return isRecord(value) && typeof value.apiKey === 'string' && value.apiKey.length <= 4096 &&
    (value.profileId === undefined || typeof value.profileId === 'string');
}
