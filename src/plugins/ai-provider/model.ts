import { createId, isRecord, type PluginContext, type PluginDefinition } from '../../core/contracts.ts';
import type {
  AIGenerateRequest,
  AIGenerateResult,
  AIGenerateStream,
  AIGenerateStreamEvent,
  AIFinishReason,
  AIChatToolCall,
  AIProviderCatalog,
  AIProviderInfo,
} from '../../protocols/ai.ts';
import type { FileReadWriteTarget } from '../../protocols/files.ts';
import {
  NOVELFORGE_LOCAL_CONNECTOR_CAPABILITY,
  type NovelForgeConnectorFetchRequest,
} from '../../protocols/novelforge.ts';
import { canReusePersistedFileHandle } from '../../ui/native-file-permission.ts';
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
import { EmbeddedReasoningStream } from './reasoning-stream.ts';

export const AI_PROVIDER_NAMESPACE = 'aiProvider';
const DEFAULT_PREFERENCES: AIProviderPreferences = {
  endpoint: '', model: '', contextWindowTokens: 16_000, authentication: 'bearer', apiStyle: 'openai',
  transport: 'http', memoryToolEnabled: false, secretPersistence: 'personal-local',
};
const PERSONAL_CONNECTIONS_KEY = 'connections-and-keys@1';
const PERSONAL_BACKUP_HANDLE_KEY = 'ai-personal-backup-handle@1';
const MAX_PERSONAL_BACKUP_CHARACTERS = 2 * 1024 * 1024;
const MAX_AI_RESPONSE_BYTES = 8 * 1024 * 1024;
const MAX_AI_STREAM_LINE_CHARACTERS = 1024 * 1024;
const MAX_AI_SSE_EVENT_CHARACTERS = 2 * 1024 * 1024;

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
      optionalCapabilities: [NOVELFORGE_LOCAL_CONNECTOR_CAPABILITY],
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
        context.network.configureOrigins(configuration.profiles
          .filter((profile) => profile.transport !== 'novelforge-connector')
          .map((profile) => profile.endpoint));
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
            const fetcher = providerFetcher(context, profile, controller.signal);
            const response = await fetchWithInitialRetry(
              fetcher,
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
            const fetcher = providerFetcher(context, profile, controller.signal);
            const response = await fetchWithInitialRetry(
              fetcher,
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
      `传输方式：${profile.transport === 'novelforge-connector' ? 'NovelForge 本机连接器' : '标准 HTTP'}`,
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
        transport: readBackupLine(body, '传输方式', false) === 'NovelForge 本机连接器'
          ? 'novelforge-connector'
          : 'http',
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
    (value.transport === undefined || value.transport === 'http' || value.transport === 'novelforge-connector') &&
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
    transport: value.transport ?? 'http',
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

function validateGenerateRequest(input: AIGenerateRequest): void {
  if (!input || !Array.isArray(input.messages) || input.messages.length < 1 || input.messages.length > 64 ||
    input.messages.some((message) => !isValidChatMessage(message)) ||
    (input.providerId !== undefined && (typeof input.providerId !== 'string' || input.providerId.length > 200)) ||
    (input.webSearch !== undefined && typeof input.webSearch !== 'boolean') ||
    (input.tools !== undefined && (!Array.isArray(input.tools) || input.tools.length > 4 ||
      input.tools.some((tool) => !isValidToolDefinition(tool)))) ||
    !Number.isFinite(input.temperature) || input.temperature < 0 || input.temperature > 2 ||
    !Number.isInteger(input.maxOutputTokens) || input.maxOutputTokens < 64 || input.maxOutputTokens > 16_384) {
    throw new Error('AI 生成请求格式不正确');
  }
}

function isValidChatMessage(value: unknown): value is AIGenerateRequest['messages'][number] {
  if (!isRecord(value) || !['system', 'user', 'assistant', 'tool'].includes(String(value.role)) ||
    typeof value.content !== 'string' || value.content.length > 200_000) return false;
  const toolCallId = value.toolCallId;
  if (toolCallId !== undefined && (typeof toolCallId !== 'string' || toolCallId.length < 1 || toolCallId.length > 240)) {
    return false;
  }
  if (value.role === 'tool' && !toolCallId) return false;
  if (value.role !== 'tool' && toolCallId !== undefined) return false;
  if (value.toolCalls === undefined) return true;
  return value.role === 'assistant' && Array.isArray(value.toolCalls) && value.toolCalls.length > 0 &&
    value.toolCalls.length <= 4 && value.toolCalls.every(isValidToolCall);
}

function isValidToolCall(value: unknown): value is AIChatToolCall {
  return isRecord(value) && typeof value.id === 'string' && value.id.length > 0 && value.id.length <= 240 &&
    typeof value.name === 'string' && value.name.length > 0 && value.name.length <= 120 &&
    typeof value.arguments === 'string' && value.arguments.length <= 8_000;
}

function isValidToolDefinition(value: unknown): boolean {
  return isRecord(value) && value.type === 'function' && isRecord(value.function) &&
    typeof value.function.name === 'string' && value.function.name.length > 0 && value.function.name.length <= 120 &&
    typeof value.function.description === 'string' && value.function.description.length <= 2_000 &&
    isRecord(value.function.parameters);
}

function resolveEndpoint(endpoint: string): string {
  return new URL(endpoint, typeof location === 'undefined' ? 'http://localhost' : location.origin).toString();
}

function buildProviderRequest(
  profile: AIProviderProfile,
  apiKey: string,
  input: AIGenerateRequest,
  stream: boolean,
): { endpoint: string; init: RequestInit } {
  const webSearchMode = resolveWebSearchMode(profile);
  if (input.webSearch && webSearchMode === 'unsupported') {
    throw new Error('当前模型连接没有 Echo-8 已验证的原生联网搜索；请关闭联网，或改用 Gemini、通义千问，或 OpenAI 联网搜索模型');
  }
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    Accept: stream ? 'text/event-stream, application/x-ndjson, application/json' : 'application/json',
  };
  if (profile.authentication === 'bearer') headers.Authorization = `Bearer ${apiKey}`;
  if (profile.authentication === 'api-key') headers['x-goog-api-key'] = apiKey;
  if (profile.apiStyle === 'gemini') {
    if (input.tools?.length) {
      throw new Error('当前 Gemini 原生连接暂不支持 Echo-8 的本地记忆工具；已继续使用常规记忆检索');
    }
    const systemText = input.messages
      .filter((message) => message.role === 'system')
      .map((message) => message.content)
      .join('\n\n');
    return {
      endpoint: resolveGeminiEndpoint(profile.endpoint, profile.model, stream),
      init: {
        method: 'POST',
        headers,
        body: JSON.stringify({
          ...(systemText ? { systemInstruction: { parts: [{ text: systemText }] } } : {}),
          contents: input.messages
            .filter((message) => message.role !== 'system')
            .map((message) => ({
              role: message.role === 'assistant' ? 'model' : 'user',
              parts: [{ text: message.content }],
            })),
          generationConfig: {
            temperature: input.temperature,
            maxOutputTokens: input.maxOutputTokens,
          },
          ...(input.webSearch ? { tools: [{ google_search: {} }] } : {}),
        }),
      },
    };
  }
  return {
    endpoint: resolveEndpoint(profile.endpoint),
    init: {
      method: 'POST',
      headers,
      body: JSON.stringify({
        model: profile.model,
        messages: input.messages,
        temperature: input.temperature,
        max_tokens: input.maxOutputTokens,
        ...(input.webSearch && webSearchMode === 'qwen' ? { enable_search: true } : {}),
        ...(input.webSearch && webSearchMode === 'openai-web-search'
          ? { web_search_options: { search_context_size: 'medium' } }
          : {}),
        ...(input.tools?.length ? { tools: input.tools, tool_choice: 'auto' } : {}),
        ...(stream ? { stream: true } : {}),
      }),
    },
  };
}

function providerFetcher(
  context: PluginContext,
  profile: AIProviderProfile,
  signal: AbortSignal,
): (input: RequestInfo | URL, init?: RequestInit) => Promise<Response> {
  if (profile.transport !== 'novelforge-connector') return context.network.fetch;
  return async (_input, init = {}) => {
    if (typeof init.body !== 'string') throw new Error('NovelForge Codex 请求正文格式不正确');
    const body: unknown = JSON.parse(init.body);
    if (!isRecord(body)) throw new Error('NovelForge Codex 请求正文必须是对象');
    return context.capabilities.request<Response>(
      NOVELFORGE_LOCAL_CONNECTOR_CAPABILITY,
      {
        path: '/v1/chat/completions',
        body,
      } satisfies NovelForgeConnectorFetchRequest,
      signal,
    );
  };
}

type WebSearchMode = 'gemini' | 'qwen' | 'openai-web-search' | 'unsupported';

function resolveWebSearchMode(profile: AIProviderProfile): WebSearchMode {
  if (profile.apiStyle === 'gemini') return 'gemini';
  let hostname: string;
  try {
    hostname = new URL(resolveEndpoint(profile.endpoint)).hostname.toLocaleLowerCase();
  } catch {
    return 'unsupported';
  }
  const model = profile.model.toLocaleLowerCase();
  if (hostname === 'dashscope.aliyuncs.com' || hostname.endsWith('.maas.aliyuncs.com')) {
    return 'qwen';
  }
  if (hostname === 'api.openai.com' && model === 'gpt-5-search-api') {
    return 'openai-web-search';
  }
  return 'unsupported';
}

function webSearchCatalogFields(profile: AIProviderProfile): {
  webSearchSupported: boolean;
  webSearchLabel?: string;
} {
  const mode = resolveWebSearchMode(profile);
  if (mode === 'gemini') return { webSearchSupported: true, webSearchLabel: 'Google Search' };
  if (mode === 'qwen') return { webSearchSupported: true, webSearchLabel: '百炼联网搜索' };
  if (mode === 'openai-web-search') return { webSearchSupported: true, webSearchLabel: 'OpenAI Web Search' };
  return { webSearchSupported: false };
}

function resolveGeminiEndpoint(endpoint: string, model: string, stream: boolean): string {
  const url = new URL(resolveEndpoint(endpoint));
  const method = stream ? ':streamGenerateContent' : ':generateContent';
  if (/:generateContent$|:streamGenerateContent$/u.test(url.pathname)) {
    url.pathname = url.pathname.replace(/:(?:stream)?generateContent$/u, method);
  } else if (/\/models\/[^/]+$/u.test(url.pathname)) {
    url.pathname = `${url.pathname}${method}`;
  } else {
    const prefix = url.pathname.replace(/\/$/u, '');
    const versioned = /\/v1(?:beta)?$/u.test(prefix) ? prefix : `${prefix}/v1beta`;
    url.pathname = `${versioned}/models/${encodeURIComponent(model)}${method}`;
  }
  if (stream) url.searchParams.set('alt', 'sse');
  return url.toString();
}

async function fetchWithInitialRetry(
  fetcher: (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>,
  endpoint: string,
  init: RequestInit,
  signal: AbortSignal,
): Promise<Response> {
  let lastError: unknown;
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      const response = await fetcher(endpoint, init);
      if (response.ok) return response;
      if (attempt === 0 && [408, 425, 429, 500, 502, 503, 504].includes(response.status)) {
        await abortableDelay(450, signal);
        continue;
      }
      throw new Error(await describeProviderHttpError(response));
    } catch (error) {
      if (signal.aborted) throw new DOMException('Aborted', 'AbortError');
      lastError = error;
      if (attempt === 0 && error instanceof TypeError) {
        await abortableDelay(450, signal);
        continue;
      }
      break;
    }
  }
  if (lastError instanceof TypeError) {
    throw new Error('无法连接模型服务：请检查接口地址、网络，以及平台是否允许浏览器跨域访问');
  }
  throw lastError instanceof Error ? lastError : new Error(String(lastError));
}

async function describeProviderHttpError(response: Response): Promise<string> {
  const prefix = `模型服务返回 HTTP ${response.status}`;
  if (!response.body) return prefix;
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  const parts: string[] = [];
  let bytes = 0;
  try {
    for (;;) {
      const chunk = await reader.read();
      if (chunk.done) break;
      bytes += chunk.value.byteLength;
      if (bytes > 64 * 1024) return prefix;
      parts.push(decoder.decode(chunk.value, { stream: true }));
    }
    parts.push(decoder.decode());
  } catch {
    return prefix;
  } finally {
    await reader.cancel().catch(() => undefined);
    reader.releaseLock();
  }
  const body = parts.join('').trim();
  if (!body) return prefix;
  let detail: string | undefined;
  try {
    detail = providerErrorMessage(JSON.parse(body) as unknown);
  } catch {
    const compact = body.replace(/\s+/gu, ' ').trim();
    if (compact && !/[<>]/u.test(compact)) detail = compact;
  }
  return detail ? `${prefix}：${detail.slice(0, 500)}` : prefix;
}

function abortableDelay(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(resolve, ms);
    signal.addEventListener('abort', () => {
      clearTimeout(timer);
      reject(new DOMException('Aborted', 'AbortError'));
    }, { once: true });
  });
}

function parseCompletion(payload: unknown): Omit<AIGenerateResult, 'provider' | 'model'> {
  const providerError = providerErrorMessage(payload);
  if (providerError) throw new Error(providerError);
  if (!isRecord(payload) || !Array.isArray(payload.choices) || !isRecord(payload.choices[0]) ||
    !isRecord(payload.choices[0].message)) {
    throw new Error('模型响应格式不是兼容的 Chat Completions 结构');
  }
  const message = payload.choices[0].message;
  const content = readMessageText(message.content);
  const separated = separateReasoning(
    content,
    readReasoningText(message),
  );
  const finalized = finalizeReasonedContent(separated);
  const text = finalized.text;
  const toolCalls = readToolCalls(message.tool_calls);
  if (!text && toolCalls.length === 0) {
    if (finalized.reasoning) throw new Error('模型只返回了思考过程，没有返回最终答案；请重试或降低模型思考强度');
    throw new Error('模型返回了空内容');
  }
  if (text.length > 100_000) throw new Error('模型返回内容超过当前提案上限');
  const usage = isRecord(payload.usage)
    ? {
        inputTokens: typeof payload.usage.prompt_tokens === 'number' ? payload.usage.prompt_tokens : undefined,
        outputTokens: typeof payload.usage.completion_tokens === 'number' ? payload.usage.completion_tokens : undefined,
      }
    : undefined;
  const finishReason = normalizeFinishReason(payload.choices[0].finish_reason);
  return {
    text,
    ...(finalized.reasoning ? { reasoning: finalized.reasoning } : {}),
    usage,
    ...(finishReason ? { finishReason } : {}),
    ...(toolCalls.length > 0 ? { toolCalls } : {}),
  };
}

function parseGeminiCompletion(payload: unknown): Omit<AIGenerateResult, 'provider' | 'model'> {
  const finalized = finalizeReasonedContent(geminiContent(payload));
  const text = finalized.text;
  if (!text) {
    if (finalized.reasoning) throw new Error('Gemini 只返回了思考过程，没有返回最终答案；请重试');
    throw new Error('Gemini 返回了空内容或响应格式不正确');
  }
  if (text.length > 100_000) throw new Error('模型返回内容超过当前提案上限');
  const usageRecord = isRecord(payload) && isRecord(payload.usageMetadata) ? payload.usageMetadata : undefined;
  const candidate = isRecord(payload) && Array.isArray(payload.candidates)
    ? payload.candidates.find(isRecord)
    : undefined;
  const finishReason = normalizeFinishReason(candidate?.finishReason);
  return {
    text,
    ...(finalized.reasoning ? { reasoning: finalized.reasoning } : {}),
    usage: usageRecord ? {
      inputTokens: typeof usageRecord.promptTokenCount === 'number' ? usageRecord.promptTokenCount : undefined,
      outputTokens: typeof usageRecord.candidatesTokenCount === 'number' ? usageRecord.candidatesTokenCount : undefined,
    } : undefined,
    ...(finishReason ? { finishReason } : {}),
  };
}

async function* readCompletionEvents(
  response: Response,
  release: () => void,
  apiStyle: AIProviderPreferences['apiStyle'],
): AsyncGenerator<AIGenerateStreamEvent> {
  try {
    const contentType = response.headers.get('content-type')?.toLocaleLowerCase() ?? '';
    await assertResponseSize(response);
    if (contentType.includes('application/json') && !contentType.includes('ndjson')) {
      const parsed = apiStyle === 'gemini'
        ? parseGeminiCompletion(await readLimitedJson(response))
        : parseCompletion(await readLimitedJson(response));
      if (parsed.reasoning) yield { type: 'delta', channel: 'reasoning', delta: parsed.reasoning };
      if (parsed.text) yield { type: 'delta', channel: 'answer', delta: parsed.text };
      for (const [index, call] of (parsed.toolCalls ?? []).entries()) {
        yield {
          type: 'tool-call', index, id: call.id, name: call.name, argumentsDelta: call.arguments,
        };
      }
      yield { type: 'complete', usage: parsed.usage, finishReason: parsed.finishReason };
      return;
    }
    if (!response.body) throw new Error('模型流式响应没有可读取的正文');

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    const sse = contentType.includes('text/event-stream');
    let buffer = '';
    let eventData: string[] = [];
    let eventDataCharacters = 0;
    let emittedCharacters = 0;
    let emittedToolFragments = 0;
    let usage: AIGenerateResult['usage'];
    let finishReason: AIFinishReason | undefined;
    let completed = false;
    let responseBytes = 0;
    const embeddedReasoning = new EmbeddedReasoningStream();

    const parseData = (raw: string): AIGenerateStreamEvent[] => {
      const data = raw.trim();
      if (!data) return [];
      if (data === '[DONE]') {
        completed = true;
        return [];
      }
      let payload: unknown;
      try {
        payload = JSON.parse(data);
      } catch {
        throw new Error('模型流式响应包含无法解析的数据');
      }
      const parsed = parseStreamPayload(payload, apiStyle);
      if (parsed.usage) usage = parsed.usage;
      if (parsed.finishReason) finishReason = parsed.finishReason;
      const rawDeltas: AIGenerateStreamEvent[] = [
        ...(parsed.reasoningDelta ? [{ type: 'delta' as const, channel: 'reasoning' as const, delta: parsed.reasoningDelta }] : []),
        ...(parsed.answerDelta ? [{ type: 'delta' as const, channel: 'answer' as const, delta: parsed.answerDelta }] : []),
        ...(parsed.toolCallDeltas ?? []).map((toolCall) => ({ type: 'tool-call' as const, ...toolCall })),
      ];
      const deltas: AIGenerateStreamEvent[] = rawDeltas.flatMap((event): AIGenerateStreamEvent[] => {
        if (event.type !== 'delta' || event.channel !== 'answer') return [event];
        return embeddedReasoning.push(event.delta).map((item): AIGenerateStreamEvent => ({
          type: 'delta', channel: item.channel, delta: item.delta,
        }));
      });
      if (deltas.length === 0) return [];
      emittedCharacters += deltas.reduce((total, item) => total +
        (item.type === 'delta' ? item.delta.length : 0), 0);
      emittedToolFragments += deltas.filter((item) => item.type === 'tool-call').length;
      if (emittedCharacters > 100_000) throw new Error('模型返回内容超过当前提案上限');
      return deltas;
    };

    const flushLine = (line: string): AIGenerateStreamEvent[] => {
      if (!sse) return parseData(line);
      if (line === '') {
        const events = parseData(eventData.join('\n'));
        eventData = [];
        eventDataCharacters = 0;
        return events;
      }
      if (line.startsWith('data:')) {
        const data = line.slice(5).trimStart();
        eventData.push(data);
        eventDataCharacters += data.length;
        if (eventDataCharacters > MAX_AI_SSE_EVENT_CHARACTERS) {
          throw new Error('模型流式响应的单个事件超过安全上限');
        }
      }
      return [];
    };

    try {
      while (!completed) {
        const chunk = await reader.read();
        if (chunk.done) break;
        responseBytes += chunk.value.byteLength;
        if (responseBytes > MAX_AI_RESPONSE_BYTES) throw new Error('模型响应体超过 8 MB 安全上限');
        buffer += decoder.decode(chunk.value, { stream: true });
        if (buffer.length > MAX_AI_STREAM_LINE_CHARACTERS && !buffer.includes('\n')) {
          throw new Error('模型流式响应的单行数据超过安全上限');
        }
        let newline = buffer.indexOf('\n');
        while (newline >= 0) {
          const line = buffer.slice(0, newline).replace(/\r$/u, '');
          if (line.length > MAX_AI_STREAM_LINE_CHARACTERS) {
            throw new Error('模型流式响应的单行数据超过安全上限');
          }
          buffer = buffer.slice(newline + 1);
          for (const event of flushLine(line)) yield event;
          if (completed) break;
          newline = buffer.indexOf('\n');
        }
      }
      buffer += decoder.decode();
      if (buffer.length > MAX_AI_STREAM_LINE_CHARACTERS) {
        throw new Error('模型流式响应的单行数据超过安全上限');
      }
      if (!completed && buffer) {
        for (const event of flushLine(buffer.replace(/\r$/u, ''))) yield event;
      }
      if (!completed && sse && eventData.length > 0) {
        for (const event of parseData(eventData.join('\n'))) yield event;
      }
      const finalDeltas = embeddedReasoning.flush();
      emittedCharacters += finalDeltas.reduce((total, item) => total + item.delta.length, 0);
      if (emittedCharacters > 100_000) throw new Error('模型返回内容超过当前提案上限');
      for (const event of finalDeltas) yield event;
    } finally {
      await reader.cancel().catch(() => undefined);
      reader.releaseLock();
    }
    if (emittedCharacters === 0 && emittedToolFragments === 0) throw new Error('模型返回了空内容');
    yield { type: 'complete', usage, finishReason };
  } finally {
    release();
  }
}

async function assertResponseSize(response: Response): Promise<void> {
  const raw = response.headers.get('content-length');
  if (!raw) return;
  const length = Number(raw);
  if (Number.isFinite(length) && length > MAX_AI_RESPONSE_BYTES) {
    await response.body?.cancel().catch(() => undefined);
    throw new Error('模型响应体超过 8 MB 安全上限');
  }
}

async function readLimitedJson(response: Response): Promise<unknown> {
  await assertResponseSize(response);
  if (!response.body) throw new Error('模型响应没有可读取的正文');
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  const parts: string[] = [];
  let bytes = 0;
  try {
    for (;;) {
      const chunk = await reader.read();
      if (chunk.done) break;
      bytes += chunk.value.byteLength;
      if (bytes > MAX_AI_RESPONSE_BYTES) throw new Error('模型响应体超过 8 MB 安全上限');
      parts.push(decoder.decode(chunk.value, { stream: true }));
    }
    parts.push(decoder.decode());
  } finally {
    await reader.cancel().catch(() => undefined);
    reader.releaseLock();
  }
  try {
    return JSON.parse(parts.join('')) as unknown;
  } catch {
    throw new Error('模型响应不是有效的 JSON');
  }
}

function parseStreamPayload(
  payload: unknown,
  apiStyle: AIProviderPreferences['apiStyle'],
): {
  answerDelta?: string;
  reasoningDelta?: string;
  toolCallDeltas?: Array<{
    index: number;
    id?: string;
    name?: string;
    argumentsDelta?: string;
  }>;
  usage?: AIGenerateResult['usage'];
  finishReason?: AIFinishReason;
} {
  if (!isRecord(payload)) throw new Error('模型流式响应格式不正确');
  const providerError = providerErrorMessage(payload);
  if (providerError) throw new Error(providerError);
  if (apiStyle === 'gemini') return parseGeminiStreamPayload(payload);
  const choice = Array.isArray(payload.choices) && isRecord(payload.choices[0])
    ? payload.choices[0]
    : undefined;
  const deltaRecord = choice && isRecord(choice.delta) ? choice.delta : undefined;
  const answerDelta = typeof deltaRecord?.content === 'string'
    ? deltaRecord.content
    : typeof choice?.text === 'string'
      ? choice.text
      : undefined;
  const reasoningDelta = typeof deltaRecord?.reasoning_content === 'string'
    ? deltaRecord.reasoning_content
    : typeof deltaRecord?.reasoning === 'string'
      ? deltaRecord.reasoning
      : undefined;
  const toolCallDeltas = readToolCallDeltas(deltaRecord?.tool_calls);
  const usage = isRecord(payload.usage)
    ? {
        inputTokens: typeof payload.usage.prompt_tokens === 'number' ? payload.usage.prompt_tokens : undefined,
        outputTokens: typeof payload.usage.completion_tokens === 'number' ? payload.usage.completion_tokens : undefined,
      }
    : undefined;
  return {
    answerDelta,
    reasoningDelta,
    ...(toolCallDeltas.length > 0 ? { toolCallDeltas } : {}),
    usage,
    finishReason: normalizeFinishReason(choice?.finish_reason),
  };
}

function providerErrorMessage(payload: unknown): string | undefined {
  if (!isRecord(payload)) return undefined;
  const error = payload.error;
  if (typeof error === 'string' && error.trim()) return error.trim().slice(0, 500);
  if (!isRecord(error)) return undefined;
  const message = [error.message, error.detail, error.code]
    .find((value) => typeof value === 'string' && value.trim());
  return typeof message === 'string' ? message.trim().slice(0, 500) : undefined;
}

function readToolCalls(value: unknown): AIChatToolCall[] {
  if (!Array.isArray(value)) return [];
  const calls: AIChatToolCall[] = [];
  for (const item of value) {
    if (!isRecord(item) || typeof item.id !== 'string' || !isRecord(item.function) ||
      typeof item.function.name !== 'string' || typeof item.function.arguments !== 'string') continue;
    const call = { id: item.id, name: item.function.name, arguments: item.function.arguments };
    if (isValidToolCall(call)) calls.push(call);
  }
  return calls.slice(0, 4);
}

function readToolCallDeltas(value: unknown): Array<{
  index: number;
  id?: string;
  name?: string;
  argumentsDelta?: string;
}> {
  if (!Array.isArray(value)) return [];
  const deltas: Array<{ index: number; id?: string; name?: string; argumentsDelta?: string }> = [];
  for (const item of value) {
    if (!isRecord(item) || !Number.isInteger(item.index) || Number(item.index) < 0 || Number(item.index) >= 4) continue;
    const fn = isRecord(item.function) ? item.function : undefined;
    const id = typeof item.id === 'string' && item.id.length <= 240 ? item.id : undefined;
    const name = typeof fn?.name === 'string' && fn.name.length <= 120 ? fn.name : undefined;
    const argumentsDelta = typeof fn?.arguments === 'string' && fn.arguments.length <= 8_000
      ? fn.arguments
      : undefined;
    if (id || name || argumentsDelta) deltas.push({ index: Number(item.index), id, name, argumentsDelta });
  }
  return deltas;
}

function parseGeminiStreamPayload(payload: Record<string, unknown>): {
  answerDelta?: string;
  reasoningDelta?: string;
  usage?: AIGenerateResult['usage'];
  finishReason?: AIFinishReason;
} {
  const usageRecord = isRecord(payload.usageMetadata) ? payload.usageMetadata : undefined;
  const candidate = Array.isArray(payload.candidates)
    ? payload.candidates.find(isRecord)
    : undefined;
  const content = geminiContent(payload);
  return {
    answerDelta: content.text || undefined,
    reasoningDelta: content.reasoning || undefined,
    usage: usageRecord ? {
      inputTokens: typeof usageRecord.promptTokenCount === 'number' ? usageRecord.promptTokenCount : undefined,
      outputTokens: typeof usageRecord.candidatesTokenCount === 'number' ? usageRecord.candidatesTokenCount : undefined,
    } : undefined,
    finishReason: normalizeFinishReason(candidate?.finishReason),
  };
}

function normalizeFinishReason(value: unknown): AIFinishReason | undefined {
  if (typeof value !== 'string' || !value.trim()) return undefined;
  const normalized = value.trim().toLocaleLowerCase();
  if (normalized === 'stop' || normalized === 'end_turn') return 'stop';
  if (normalized === 'length' || normalized === 'max_tokens' || normalized === 'max_output_tokens') {
    return 'length';
  }
  if (normalized.includes('safety') || normalized.includes('content_filter') || normalized === 'recitation') {
    return 'content-filter';
  }
  if (normalized.includes('tool')) return 'tool-calls';
  return 'other';
}

function geminiContent(payload: unknown): { text: string; reasoning: string } {
  if (!isRecord(payload) || !Array.isArray(payload.candidates)) return { text: '', reasoning: '' };
  const candidate = payload.candidates.find(isRecord);
  if (!candidate || !isRecord(candidate.content) || !Array.isArray(candidate.content.parts)) {
    return { text: '', reasoning: '' };
  }
  const parts = candidate.content.parts.filter(isRecord);
  return {
    text: parts.filter((part) => part.thought !== true).map((part) => typeof part.text === 'string' ? part.text : '').join(''),
    reasoning: parts.filter((part) => part.thought === true).map((part) => typeof part.text === 'string' ? part.text : '').join(''),
  };
}

function separateReasoning(text: string, explicitReasoning?: string): { text: string; reasoning: string } {
  let answer = text;
  const embedded: string[] = [];
  answer = answer.replace(/<(?:think|analysis)>([\s\S]*?)<\/(?:think|analysis)>/giu, (_match, body: string) => {
    if (body.trim()) embedded.push(body.trim());
    return '';
  });
  return {
    text: answer.trim(),
    reasoning: [explicitReasoning?.trim() ?? '', ...embedded].filter(Boolean).join('\n\n'),
  };
}

function readMessageText(content: unknown): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content.filter(isRecord).map((part) => {
    if (typeof part.text === 'string') return part.text;
    if (isRecord(part.text) && typeof part.text.value === 'string') return part.text.value;
    return '';
  }).join('');
}

function readReasoningText(message: Record<string, unknown>): string | undefined {
  const direct = [message.reasoning_content, message.reasoning]
    .find((value) => typeof value === 'string');
  if (typeof direct === 'string' && direct.trim()) return direct;
  if (!Array.isArray(message.reasoning_details)) return undefined;
  const text = message.reasoning_details.filter(isRecord).map((part) =>
    typeof part.text === 'string' ? part.text : typeof part.summary === 'string' ? part.summary : '').join('');
  return text || undefined;
}

function finalizeReasonedContent(content: { text: string; reasoning: string }): {
  text: string;
  reasoning: string;
} {
  const text = content.text.trim();
  const reasoning = content.reasoning.trim();
  return { text, reasoning };
}
