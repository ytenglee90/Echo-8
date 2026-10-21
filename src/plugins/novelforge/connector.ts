import { isRecord, type PluginContext } from '../../core/contracts.ts';
import {
  NOVELFORGE_LOCAL_CONNECTOR_CAPABILITY,
  type NovelForgeArtifact,
  type NovelForgeChangeReceipt,
  type NovelForgeConnectorConfiguration,
  type NovelForgeConnectorFetchRequest,
  type NovelForgeManifest,
  type NovelForgeProjectSummary,
} from '../../protocols/novelforge.ts';
import {
  validateNovelForgeArtifact,
  validateNovelForgeManifest,
  validateNovelForgeProject,
  validateNovelForgeReceipt,
} from './exchange.ts';

export const NOVELFORGE_CONNECTOR_PREFERENCE_KEY = 'local-connector@1';
export const NOVELFORGE_CONNECTOR_PROTOCOL = 'novelforge-canvas-local/2';
export const NOVELFORGE_RUNTIME_PROTOCOL = 'novelforge-canvas-runtime/2';

const TOKEN_PATTERN = /^[A-Za-z0-9_-]{43,256}$/u;
const MAX_JSON_BYTES = 128 * 1024 * 1024;
const SNAPSHOT_PAGE_SIZE = 20;

export interface ConnectorSnapshot {
  manifest: NovelForgeManifest;
  artifacts: NovelForgeArtifact[];
  receipts: NovelForgeChangeReceipt[];
}

export function normalizeConnectorConfiguration(value: unknown): NovelForgeConnectorConfiguration {
  if (!isRecord(value) || typeof value.endpoint !== 'string' || typeof value.pairingToken !== 'string') {
    throw new Error('本机连接器配置不完整');
  }
  const endpoint = normalizeLoopbackEndpoint(value.endpoint);
  const pairingToken = value.pairingToken.trim();
  if (!TOKEN_PATTERN.test(pairingToken)) throw new Error('本机连接器配对令牌格式不正确');
  return { endpoint, pairingToken };
}

export function normalizeLoopbackEndpoint(value: string): string {
  let url: URL;
  try {
    url = new URL(value.trim());
  } catch {
    throw new Error('本机连接器地址不是有效 URL');
  }
  const host = url.hostname.toLowerCase();
  const loopback = host === 'localhost' || host === '[::1]' || host === '::1' ||
    /^127(?:\.[0-9]{1,3}){3}$/u.test(host);
  if (url.protocol !== 'http:' || !loopback || url.username || url.password ||
    (url.pathname !== '/' && url.pathname !== '') || url.search || url.hash) {
    throw new Error('本机连接器只接受无路径、无凭据的 HTTP 回环地址');
  }
  if (host.startsWith('127.') && host.split('.').some((part) => Number(part) > 255)) {
    throw new Error('本机连接器回环地址不合法');
  }
  return url.origin;
}

export function installConnectorCapability(
  context: PluginContext,
  configuration: () => NovelForgeConnectorConfiguration | undefined,
): void {
  context.capabilities.provide<NovelForgeConnectorFetchRequest, Response>({
    key: NOVELFORGE_LOCAL_CONNECTOR_CAPABILITY,
    invoke: async (request, signal) => {
      const current = configuration();
      if (!current) throw new Error('请先在 NovelForge 面板完成一次本机连接器配对');
      if (!isConnectorFetchRequest(request)) throw new Error('本机连接器请求格式不正确');
      return connectorFetch(context, current, request.path, request.body, signal ?? request.signal);
    },
  });
}

export async function connectorFetch(
  context: PluginContext,
  configuration: NovelForgeConnectorConfiguration,
  path: NovelForgeConnectorFetchRequest['path'],
  body: Record<string, unknown>,
  signal?: AbortSignal,
): Promise<Response> {
  const current = normalizeConnectorConfiguration(configuration);
  return context.network.connector(`${current.endpoint}${path}`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${current.pairingToken}`,
      'Content-Type': 'application/json',
      Accept: path === '/v1/chat/completions'
        ? 'text/event-stream, application/x-ndjson, application/json'
        : 'application/json',
    },
    body: JSON.stringify(body),
    signal,
  });
}

export async function readConnectorProjects(response: Response): Promise<NovelForgeProjectSummary[]> {
  const value = await readConnectorJson(response);
  if (!isRecord(value) || value.protocol !== NOVELFORGE_RUNTIME_PROTOCOL || !Array.isArray(value.projects) ||
    value.projects.length > 500) {
    throw new Error('本机 Runtime 返回了不兼容的项目列表');
  }
  return value.projects.map(validateNovelForgeProject);
}

export async function readConnectorSnapshot(
  fetchPage: (body: Record<string, unknown>) => Promise<Response>,
  projectId: string,
  receiptRequestIds: string[],
): Promise<ConnectorSnapshot> {
  let cursor = 0;
  let manifest: NovelForgeManifest | undefined;
  const artifacts = new Map<string, NovelForgeArtifact>();
  const receipts = new Map<string, NovelForgeChangeReceipt>();
  for (;;) {
    const value = await readConnectorJson(await fetchPage({
      project_id: projectId,
      cursor,
      limit: SNAPSHOT_PAGE_SIZE,
      receipt_request_ids: receiptRequestIds,
    }));
    if (!isRecord(value) || value.protocol !== NOVELFORGE_RUNTIME_PROTOCOL ||
      !Array.isArray(value.artifacts) || !Array.isArray(value.receipts) ||
      value.cursor !== cursor || !Number.isInteger(value.total_entries)) {
      throw new Error('本机 Runtime 返回了不兼容的快照页');
    }
    const pageManifest = await validateNovelForgeManifest(value.manifest);
    if (pageManifest.project.project_id !== projectId ||
      (manifest && pageManifest.snapshot_digest !== manifest.snapshot_digest)) {
      throw new Error('NovelForge 快照在分页读取过程中发生变化，请重试');
    }
    manifest ??= pageManifest;
    const entries = new Map(pageManifest.entries.map((entry) => [entry.entry_id, entry]));
    for (const raw of value.artifacts) {
      if (!isRecord(raw) || typeof raw.entry_id !== 'string') throw new Error('NovelForge 快照工件缺少 entry_id');
      const entry = entries.get(raw.entry_id);
      if (!entry) throw new Error(`NovelForge 快照包含未声明工件：${raw.entry_id}`);
      artifacts.set(raw.entry_id, await validateNovelForgeArtifact(raw, pageManifest, entry));
    }
    for (const raw of value.receipts) {
      if (!isRecord(raw) || typeof raw.request_id !== 'string') throw new Error('NovelForge 回执缺少 request_id');
      receipts.set(raw.request_id, validateNovelForgeReceipt(raw, raw.request_id));
    }
    if (value.next_cursor === null) break;
    if (!Number.isInteger(value.next_cursor) || Number(value.next_cursor) <= cursor) {
      throw new Error('NovelForge 快照分页游标没有前进');
    }
    cursor = Number(value.next_cursor);
  }
  if (!manifest || artifacts.size !== manifest.entries.length) {
    throw new Error('NovelForge 快照工件数量与 manifest 不一致');
  }
  return { manifest, artifacts: [...artifacts.values()], receipts: [...receipts.values()] };
}

export async function readConnectorJson(response: Response): Promise<unknown> {
  const declared = Number(response.headers.get('content-length') ?? 0);
  if (Number.isFinite(declared) && declared > MAX_JSON_BYTES) throw new Error('本机连接器响应超过 128 MiB 上限');
  const text = await response.text();
  if (new TextEncoder().encode(text).byteLength > MAX_JSON_BYTES) throw new Error('本机连接器响应超过 128 MiB 上限');
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    throw new Error(`本机连接器返回了无法解析的响应（HTTP ${response.status}）`);
  }
  if (!response.ok) {
    const message = isRecord(value) && isRecord(value.error) && typeof value.error.message === 'string'
      ? value.error.message
      : `本机连接器返回 HTTP ${response.status}`;
    throw new Error(message);
  }
  return value;
}

function isConnectorFetchRequest(value: unknown): value is NovelForgeConnectorFetchRequest {
  return isRecord(value) && [
    '/v1/connector/health',
    '/v1/chat/completions',
    '/v1/runtime/projects',
    '/v1/runtime/snapshot',
    '/v1/runtime/proposals',
  ].includes(String(value.path)) && isRecord(value.body) &&
    (value.signal === undefined || value.signal instanceof AbortSignal);
}
