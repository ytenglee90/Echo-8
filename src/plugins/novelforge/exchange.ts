import { isRecord } from '../../core/contracts.ts';
import type { FileDirectoryTarget, FileSaveTarget } from '../../protocols/files.ts';
import {
  NOVELFORGE_ARTIFACT_KIND,
  NOVELFORGE_EXCHANGE_KIND,
  NOVELFORGE_PROTOCOL_VERSION,
  NOVELFORGE_RECEIPT_KIND,
  type NovelForgeArtifact,
  type NovelForgeChangeReceipt,
  type NovelForgeManifest,
  type NovelForgeManifestEntry,
  type NovelForgeProjectSummary,
} from '../../protocols/novelforge.ts';

const MAX_MANIFEST_BYTES = 32 * 1024 * 1024;
const MAX_ARTIFACT_BYTES = 96 * 1024 * 1024;
const MAX_RECEIPT_BYTES = 1024 * 1024;
const MAX_ENTRIES = 250_000;
const SHA256_PATTERN = /^sha256:[0-9a-f]{64}$/u;
const SAFE_SEGMENT = /^[A-Za-z0-9._-]{1,160}$/u;

export async function readNovelForgeExchange(
  directory: FileDirectoryTarget,
  signal?: AbortSignal,
): Promise<{ manifest: NovelForgeManifest; artifacts: NovelForgeArtifact[] }> {
  const manifestValue = await readJsonPath(directory, ['manifest.json'], MAX_MANIFEST_BYTES, signal);
  const manifest = await validateNovelForgeManifest(manifestValue);
  const artifacts: NovelForgeArtifact[] = [];
  for (const entry of manifest.entries) {
    assertNotAborted(signal);
    const value = await readJsonPath(
      directory,
      validatedPath(entry.file_path, 'artifacts'),
      MAX_ARTIFACT_BYTES,
      signal,
    );
    artifacts.push(await validateNovelForgeArtifact(value, manifest, entry));
  }
  return { manifest, artifacts };
}

export async function readNovelForgeReceipt(
  directory: FileDirectoryTarget,
  requestId: string,
  signal?: AbortSignal,
): Promise<NovelForgeChangeReceipt | undefined> {
  if (!SAFE_SEGMENT.test(requestId)) return undefined;
  try {
    const value = await readJsonPath(
      directory,
      ['receipts', `${requestId}.json`],
      MAX_RECEIPT_BYTES,
      signal,
    );
    return validateNovelForgeReceipt(value, requestId);
  } catch (error) {
    if (isNotFoundError(error)) return undefined;
    throw error;
  }
}

export async function writeNovelForgeRequest(
  directory: FileDirectoryTarget,
  requestId: string,
  request: unknown,
  signal?: AbortSignal,
): Promise<void> {
  if (!SAFE_SEGMENT.test(requestId)) throw new Error('NovelForge 请求 ID 不安全');
  assertNotAborted(signal);
  const text = `${canonicalJson(request)}\n`;
  if (new TextEncoder().encode(text).byteLength > MAX_ARTIFACT_BYTES) {
    throw new Error('NovelForge 改动提案超过 96 MiB 上限');
  }
  const target = await resolveFile(directory, ['requests', `${requestId}.json`], true);
  const writable = await target.createWritable();
  try {
    assertNotAborted(signal);
    await writable.write(new Blob([text], { type: 'application/json;charset=utf-8' }));
    assertNotAborted(signal);
    await writable.close();
  } catch (error) {
    await writable.abort?.();
    throw error;
  }
}

export async function digestNovelForgeText(title: string, body: string): Promise<string> {
  return digestJson({ title, body });
}

export async function digestJson(value: unknown): Promise<string> {
  const data = new TextEncoder().encode(`${canonicalJson(value)}\n`);
  const digest = await globalThis.crypto.subtle.digest('SHA-256', data);
  return `sha256:${[...new Uint8Array(digest)].map((value) => value.toString(16).padStart(2, '0')).join('')}`;
}

export function canonicalJson(value: unknown): string {
  if (value === null || typeof value === 'boolean' || typeof value === 'string') {
    return JSON.stringify(value);
  }
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new Error('NovelForge 协议不接受非有限数字');
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (isRecord(value)) {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(',')}}`;
  }
  throw new Error('NovelForge 协议只接受 JSON 值');
}

export async function validateNovelForgeManifest(value: unknown): Promise<NovelForgeManifest> {
  if (!isRecord(value) || value.kind !== NOVELFORGE_EXCHANGE_KIND ||
    value.protocol_version !== NOVELFORGE_PROTOCOL_VERSION ||
    value.schema !== 'novelforge.canvas.exchange.v1' ||
    typeof value.generated_at !== 'string' || typeof value.snapshot_digest !== 'string' ||
    !SHA256_PATTERN.test(value.snapshot_digest) || !Array.isArray(value.entries) ||
    value.entries.length > MAX_ENTRIES) {
    throw new Error('NovelForge manifest 不符合 v1 协议');
  }
  const project = validateNovelForgeProject(value.project);
  const entries = value.entries.map(validateEntry);
  const ids = new Set(entries.map((entry) => entry.entry_id));
  if (ids.size !== entries.length) throw new Error('NovelForge manifest 含重复 entry_id');
  const expected = await digestJson({ project, entries });
  if (expected !== value.snapshot_digest) throw new Error('NovelForge manifest snapshot digest 不匹配');
  return {
    kind: NOVELFORGE_EXCHANGE_KIND,
    protocol_version: NOVELFORGE_PROTOCOL_VERSION,
    schema: 'novelforge.canvas.exchange.v1',
    project,
    generated_at: value.generated_at,
    entries,
    snapshot_digest: value.snapshot_digest,
  };
}

export function validateNovelForgeProject(value: unknown): NovelForgeProjectSummary {
  if (!isRecord(value) || typeof value.project_id !== 'string' || typeof value.title !== 'string' ||
    !Number.isInteger(value.chapter_count) || Number(value.chapter_count) <= 0 ||
    typeof value.stage !== 'string' || typeof value.workflow_status !== 'string' ||
    typeof value.updated_at !== 'string') {
    throw new Error('NovelForge manifest 项目信息不完整');
  }
  return {
    project_id: value.project_id,
    title: value.title,
    chapter_count: Number(value.chapter_count),
    stage: value.stage,
    workflow_status: value.workflow_status,
    updated_at: value.updated_at,
  };
}

function validateEntry(value: unknown): NovelForgeManifestEntry {
  if (!isRecord(value) || typeof value.entry_id !== 'string' ||
    typeof value.artifact_id !== 'string' || typeof value.artifact_type !== 'string' ||
    !Number.isInteger(value.artifact_revision) || Number(value.artifact_revision) <= 0 ||
    typeof value.authority_digest !== 'string' || !SHA256_PATTERN.test(value.authority_digest) ||
    typeof value.content_digest !== 'string' || !SHA256_PATTERN.test(value.content_digest) ||
    typeof value.authority_status !== 'string' || typeof value.locked !== 'boolean' ||
    !['DIRECT_AUTHOR_COMMIT', 'PROPOSAL_ONLY', 'READ_ONLY'].includes(String(value.editable_mode)) ||
    !(value.chapter === null || (Number.isInteger(value.chapter) && Number(value.chapter) > 0)) ||
    !(value.card_id === null || typeof value.card_id === 'string') ||
    typeof value.file_path !== 'string' || !Number.isFinite(value.x) || !Number.isFinite(value.y)) {
    throw new Error('NovelForge manifest entry 不合法');
  }
  validatedPath(value.file_path, 'artifacts');
  return {
    entry_id: value.entry_id,
    artifact_id: value.artifact_id,
    artifact_type: value.artifact_type,
    artifact_revision: Number(value.artifact_revision),
    authority_digest: value.authority_digest,
    content_digest: value.content_digest,
    authority_status: value.authority_status,
    locked: value.locked,
    editable_mode: value.editable_mode as NovelForgeManifestEntry['editable_mode'],
    chapter: value.chapter === null ? null : Number(value.chapter),
    card_id: value.card_id === null ? null : value.card_id,
    file_path: value.file_path,
    x: Number(value.x),
    y: Number(value.y),
  };
}

export async function validateNovelForgeArtifact(
  value: unknown,
  manifest: NovelForgeManifest,
  entry: NovelForgeManifestEntry,
): Promise<NovelForgeArtifact> {
  if (!isRecord(value) || value.kind !== NOVELFORGE_ARTIFACT_KIND ||
    value.protocol_version !== NOVELFORGE_PROTOCOL_VERSION ||
    value.project_id !== manifest.project.project_id || typeof value.title !== 'string' ||
    typeof value.body !== 'string' || !isRecord(value.metadata)) {
    throw new Error(`NovelForge artifact ${entry.entry_id} 不符合 v1 协议`);
  }
  for (const [key, expected] of Object.entries(entry)) {
    if (value[key] !== expected) throw new Error(`NovelForge artifact ${entry.entry_id} 与 manifest 不一致`);
  }
  const contentDigest = await digestNovelForgeText(value.title, value.body);
  if (contentDigest !== entry.content_digest) {
    throw new Error(`NovelForge artifact ${entry.entry_id} 内容摘要不匹配`);
  }
  return {
    ...entry,
    kind: NOVELFORGE_ARTIFACT_KIND,
    protocol_version: NOVELFORGE_PROTOCOL_VERSION,
    project_id: manifest.project.project_id,
    title: value.title,
    body: value.body,
    metadata: value.metadata,
  };
}

export function validateNovelForgeReceipt(value: unknown, requestId: string): NovelForgeChangeReceipt {
  const statuses = ['REVIEW_REQUIRED', 'CONFLICT', 'APPROVAL_REQUIRED', 'COMMITTED', 'REJECTED', 'BLOCKED'];
  if (!isRecord(value) || value.kind !== NOVELFORGE_RECEIPT_KIND ||
    value.protocol_version !== NOVELFORGE_PROTOCOL_VERSION || value.request_id !== requestId ||
    typeof value.project_id !== 'string' || !statuses.includes(String(value.status)) ||
    !(value.proposal_id === null || typeof value.proposal_id === 'string') ||
    !(value.candidate_digest === null || (typeof value.candidate_digest === 'string' && SHA256_PATTERN.test(value.candidate_digest))) ||
    !(value.authority_candidate_digest === null || (typeof value.authority_candidate_digest === 'string' && SHA256_PATTERN.test(value.authority_candidate_digest))) ||
    !(value.conflict_reason === null || typeof value.conflict_reason === 'string') ||
    !(value.approval_request_id === null || typeof value.approval_request_id === 'string') ||
    !(value.result_revision === null || Number.isInteger(value.result_revision)) ||
    !(value.result_digest === null || (typeof value.result_digest === 'string' && SHA256_PATTERN.test(value.result_digest))) ||
    typeof value.updated_at !== 'string') {
    throw new Error(`NovelForge receipt ${requestId} 不合法`);
  }
  return value as unknown as NovelForgeChangeReceipt;
}

async function readJsonPath(
  root: FileDirectoryTarget,
  path: string[],
  limit: number,
  signal?: AbortSignal,
): Promise<unknown> {
  assertNotAborted(signal);
  const handle = await resolveFile(root, path, false);
  if (!handle.getFile) throw new Error('当前目录句柄不支持读取文件');
  const file = await handle.getFile();
  if (file.size > limit) throw new Error(`NovelForge 文件 ${path.join('/')} 超过大小上限`);
  assertNotAborted(signal);
  const text = await file.text();
  assertNotAborted(signal);
  return JSON.parse(text);
}

async function resolveFile(
  root: FileDirectoryTarget,
  path: string[],
  create: boolean,
): Promise<FileSaveTarget> {
  if (path.length === 0) throw new Error('NovelForge 文件路径为空');
  let directory = root;
  for (const segment of path.slice(0, -1)) {
    if (!SAFE_SEGMENT.test(segment) || !directory.getDirectoryHandle) {
      throw new Error('当前目录句柄不支持 NovelForge 子目录协议');
    }
    directory = await directory.getDirectoryHandle(segment, { create });
  }
  const filename = path.at(-1)!;
  if (!SAFE_SEGMENT.test(filename)) throw new Error('NovelForge 文件名不安全');
  return directory.getFileHandle(filename, { create });
}

function validatedPath(value: string, requiredRoot: string): string[] {
  const parts = value.split('/');
  if (parts.length !== 2 || parts[0] !== requiredRoot || parts.some((part) => !SAFE_SEGMENT.test(part))) {
    throw new Error('NovelForge manifest 文件路径越界');
  }
  return parts;
}

function isNotFoundError(error: unknown): boolean {
  return error instanceof DOMException && error.name === 'NotFoundError' ||
    error instanceof Error && /not found|不存在|ENOENT/iu.test(error.message);
}

function assertNotAborted(signal?: AbortSignal): void {
  if (signal?.aborted) throw signal.reason ?? new DOMException('Aborted', 'AbortError');
}
