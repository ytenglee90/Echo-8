import assert from 'node:assert/strict';
import test from 'node:test';
import { ApplicationKernel } from '../src/core/kernel.ts';
import type { PluginDefinition } from '../src/core/contracts.ts';
import { defineManifest } from '../src/plugins/manifest.ts';
import { createNovelForgePlugin } from '../src/plugins/novelforge/model.ts';
import { createTextNodePlugin } from '../src/plugins/text-node/plugin.ts';
import type { ContentSummary } from '../src/protocols/content.ts';
import type {
  FileDirectoryTarget,
  FileSaveTarget,
  FileWritableTarget,
} from '../src/protocols/files.ts';
import { EXTERNAL_PROJECT_DIRECTORY_CAPABILITY } from '../src/protocols/files.ts';
import {
  NOVELFORGE_ARTIFACT_KIND,
  NOVELFORGE_EXCHANGE_KIND,
  NOVELFORGE_PROTOCOL_VERSION,
  NOVELFORGE_REQUEST_KIND,
  type NovelForgeChangeRequest,
  type NovelForgeManifest,
  type NovelForgePanelState,
} from '../src/protocols/novelforge.ts';
import {
  canonicalJson,
  digestJson,
  digestNovelForgeText,
  readNovelForgeExchange,
  writeNovelForgeRequest,
} from '../src/plugins/novelforge/exchange.ts';
import {
  normalizeConnectorConfiguration,
  normalizeLoopbackEndpoint,
  readConnectorProjects,
  readConnectorSnapshot,
} from '../src/plugins/novelforge/connector.ts';

test('NovelForge connector accepts only authenticated loopback endpoints', () => {
  const token = 'A'.repeat(43);
  assert.deepEqual(normalizeConnectorConfiguration({
    endpoint: 'http://127.0.0.1:32147/',
    pairingToken: token,
  }), { endpoint: 'http://127.0.0.1:32147', pairingToken: token });
  assert.equal(normalizeLoopbackEndpoint('http://localhost:32147'), 'http://localhost:32147');
  assert.throws(() => normalizeLoopbackEndpoint('https://127.0.0.1:32147'), /HTTP 回环/u);
  assert.throws(() => normalizeLoopbackEndpoint('http://example.com:32147'), /HTTP 回环/u);
  assert.throws(() => normalizeLoopbackEndpoint('http://127.0.0.1:32147/v1'), /HTTP 回环/u);
  assert.throws(() => normalizeConnectorConfiguration({
    endpoint: 'http://127.0.0.1:32147',
    pairingToken: 'short',
  }), /令牌格式/u);
});

test('NovelForge connector validates paginated Runtime snapshots before exposing them', async () => {
  const root = new MemoryDirectory('BOOK-1');
  await seedSingleArtifact(root, {
    revision: 1,
    authorityDigest: `sha256:${'1'.repeat(64)}`,
    title: '连接器工件',
    body: '只能通过校验后进入画布。',
  });
  const manifest = JSON.parse(await root.read(['manifest.json'])) as NovelForgeManifest;
  const artifact = JSON.parse(await root.read(['artifacts', 'card.json'])) as Record<string, unknown>;
  const response = (body: unknown) => new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });
  const projects = await readConnectorProjects(response({
    protocol: 'novelforge-canvas-runtime/2',
    projects: [manifest.project],
  }));
  assert.equal(projects[0]?.project_id, 'BOOK-1');
  const snapshot = await readConnectorSnapshot(async (request) => {
    assert.equal(request.project_id, 'BOOK-1');
    return response({
      protocol: 'novelforge-canvas-runtime/2',
      manifest,
      artifacts: [artifact],
      receipts: [],
      cursor: 0,
      next_cursor: null,
      total_entries: 1,
    });
  }, 'BOOK-1', []);
  assert.equal(snapshot.manifest.snapshot_digest, manifest.snapshot_digest);
  assert.equal(snapshot.artifacts[0]?.body, '只能通过校验后进入画布。');

  await assert.rejects(() => readConnectorSnapshot(async () => response({
    protocol: 'novelforge-canvas-runtime/2',
    manifest,
    artifacts: [{ ...artifact, body: '被中途篡改' }],
    receipts: [],
    cursor: 0,
    next_cursor: null,
    total_entries: 1,
  }), 'BOOK-1', []), /内容摘要不匹配/u);
});

test('NovelForge canonical JSON digest matches the Runtime UTF-8 contract', async () => {
  assert.equal(canonicalJson({ title: '钥匙', body: '雨夜' }), '{"body":"雨夜","title":"钥匙"}');
  assert.equal(
    await digestNovelForgeText('钥匙', '雨夜'),
    'sha256:91a93f41446ee43050703f7da32fbc797be14a2f16bfdd4137f27b79707a1e17',
  );
});

test('NovelForge exchange validates manifest, artifact and snapshot digests', async () => {
  const root = new MemoryDirectory('BOOK-1');
  const artifact = {
    kind: NOVELFORGE_ARTIFACT_KIND,
    protocol_version: NOVELFORGE_PROTOCOL_VERSION,
    project_id: 'BOOK-1',
    entry_id: 'material-card:CARD-1',
    artifact_id: 'CARD-1',
    artifact_type: 'MATERIAL_CARD',
    artifact_revision: 1,
    authority_digest: `sha256:${'1'.repeat(64)}`,
    content_digest: await digestNovelForgeText('雨夜钥匙', '陌生人交出钥匙。'),
    authority_status: 'ACTIVE',
    locked: false,
    editable_mode: 'DIRECT_AUTHOR_COMMIT' as const,
    chapter: null,
    card_id: 'CARD-1',
    file_path: 'artifacts/card.json',
    x: -720,
    y: 4400,
    title: '雨夜钥匙',
    body: '陌生人交出钥匙。',
    metadata: { category: 'plot_fragment' },
  };
  const project = {
    project_id: 'BOOK-1',
    title: '联调书',
    chapter_count: 200,
    stage: 'CREATED',
    workflow_status: 'PENDING',
    updated_at: '2026-10-19T00:00:00.000Z',
  };
  const entries = [{
    entry_id: artifact.entry_id,
    artifact_id: artifact.artifact_id,
    artifact_type: artifact.artifact_type,
    artifact_revision: artifact.artifact_revision,
    authority_digest: artifact.authority_digest,
    content_digest: artifact.content_digest,
    authority_status: artifact.authority_status,
    locked: artifact.locked,
    editable_mode: artifact.editable_mode,
    chapter: artifact.chapter,
    card_id: artifact.card_id,
    file_path: artifact.file_path,
    x: artifact.x,
    y: artifact.y,
  }];
  const manifest: NovelForgeManifest = {
    kind: NOVELFORGE_EXCHANGE_KIND,
    protocol_version: NOVELFORGE_PROTOCOL_VERSION,
    schema: 'novelforge.canvas.exchange.v1',
    project,
    generated_at: '2026-10-19T00:00:01.000Z',
    entries,
    snapshot_digest: await digestJson({ project, entries }),
  };
  await root.put(['manifest.json'], JSON.stringify(manifest));
  await root.put(['artifacts', 'card.json'], JSON.stringify(artifact));

  const loaded = await readNovelForgeExchange(root);
  assert.equal(loaded.manifest.snapshot_digest, manifest.snapshot_digest);
  assert.equal(loaded.artifacts[0].body, '陌生人交出钥匙。');

  await root.put(['artifacts', 'card.json'], JSON.stringify({ ...artifact, body: '被篡改' }));
  await assert.rejects(() => readNovelForgeExchange(root), /内容摘要不匹配/u);
});

test('NovelForge request writer creates only the governed requests path', async () => {
  const root = new MemoryDirectory('BOOK-1');
  const candidateDigest = await digestNovelForgeText('新标题', '新正文');
  const request: NovelForgeChangeRequest = {
    kind: NOVELFORGE_REQUEST_KIND,
    protocol_version: NOVELFORGE_PROTOCOL_VERSION,
    request_id: 'CANVAS-REQ-12345678',
    project_id: 'BOOK-1',
    entry_id: 'material-card:CARD-1',
    artifact_type: 'MATERIAL_CARD',
    artifact_id: 'CARD-1',
    base_revision: 1,
    base_digest: `sha256:${'1'.repeat(64)}`,
    base_content_digest: `sha256:${'2'.repeat(64)}`,
    canvas_node_id: 'node:1',
    canvas_node_revision: 2,
    candidate_title: '新标题',
    candidate_body: '新正文',
    candidate_digest: candidateDigest,
    created_at: '2026-10-19T00:00:00.000Z',
  };
  await writeNovelForgeRequest(root, request.request_id, request);
  const written = JSON.parse(await root.read(['requests', `${request.request_id}.json`]));
  assert.equal(written.candidate_digest, candidateDigest);
  await assert.rejects(
    () => writeNovelForgeRequest(root, '../escape', request),
    /请求 ID 不安全/u,
  );
});

test('NovelForge plugin imports Runtime projections, queues proposals and preserves both sides on conflict', async () => {
  const root = new MemoryDirectory('BOOK-1');
  await seedSingleArtifact(root, {
    revision: 1,
    authorityDigest: `sha256:${'1'.repeat(64)}`,
    title: '雨夜钥匙',
    body: '陌生人交出钥匙。',
  });
  const directoryProvider: PluginDefinition = {
    manifest: defineManifest('novelforge-test-directory', 'NovelForge 测试目录', {
      providesCapabilities: [EXTERNAL_PROJECT_DIRECTORY_CAPABILITY],
    }),
    start(context) {
      context.capabilities.provide<undefined, FileDirectoryTarget>({
        key: EXTERNAL_PROJECT_DIRECTORY_CAPABILITY,
        invoke: () => root,
      });
    },
  };
  const kernel = new ApplicationKernel([
    directoryProvider,
    createTextNodePlugin(),
    createNovelForgePlugin(),
  ], { persistenceLaunchPolicy: 'fresh-session' });
  await kernel.start();
  let lastStatus: { state?: string; message?: string } | undefined;
  const disposeStatus = kernel.router.subscribeSignal(
    'core.test',
    'novelforge.status',
    (envelope) => { lastStatus = envelope.payload as { state?: string; message?: string }; },
  );

  try {
    await kernel.router.dispatch('novelforge.connect', undefined, 'core.test');
    let state = await waitFor(async () => {
      const candidate = await kernel.router.ask<NovelForgePanelState>(
        'novelforge.state',
        undefined,
        'core.test',
      );
      if (lastStatus?.state === 'error') throw new Error(lastStatus.message);
      return candidate.bindings.length === 1 && candidate.counts.synced === 1 ? candidate : undefined;
    }, 2_000);
    const initial = state.bindings[0]!;
    assert.equal(initial.runtimeTitle, '雨夜钥匙');
    assert.equal(initial.syncState, 'synced');
    assert.equal(await readNodeBody(kernel, initial.canvasNodeId), '陌生人交出钥匙。');

    await seedSingleArtifact(root, {
      revision: 2,
      authorityDigest: `sha256:${'3'.repeat(64)}`,
      title: '雨夜钥匙（权威更新）',
      body: '陌生人在钟楼下交出钥匙。',
    });
    await kernel.router.dispatch('novelforge.sync', undefined, 'core.test');
    state = await waitFor(async () => {
      const candidate = await kernel.router.ask<NovelForgePanelState>(
        'novelforge.state',
        undefined,
        'core.test',
      );
      return candidate.bindings[0]?.artifactRevision === 2 && candidate.counts.synced === 1
        ? candidate
        : undefined;
    }, 2_000);
    const refreshed = state.bindings[0]!;
    const refreshedSummary = (await kernel.capabilities.request<ContentSummary[]>(
      'content.summariesById@1',
      { nodeIds: [refreshed.canvasNodeId] },
    ))[0]!;
    assert.equal(refreshedSummary.title, '雨夜钥匙（权威更新）');
    assert.equal(await readNodeBody(kernel, refreshed.canvasNodeId), '陌生人在钟楼下交出钥匙。');

    await kernel.router.dispatch('content.applyDelta', {
      nodeId: refreshed.canvasNodeId,
      start: refreshedSummary.length,
      deleteCount: 0,
      insert: '画布作者补充：钥匙有裂纹。',
      expectedRevision: refreshedSummary.revision,
    }, 'core.test');
    state = await waitFor(async () => {
      const candidate = await kernel.router.ask<NovelForgePanelState>(
        'novelforge.state',
        undefined,
        'core.test',
      );
      return candidate.counts['local-draft'] === 1 ? candidate : undefined;
    }).catch(async (error) => {
      const candidate = await kernel.router.ask<NovelForgePanelState>(
        'novelforge.state',
        undefined,
        'core.test',
      );
      const current = (await kernel.capabilities.request<ContentSummary[]>(
        'content.summariesById@1',
        { nodeIds: [refreshed.canvasNodeId] },
      ))[0];
      throw new Error(`${String(error)}; state=${JSON.stringify(candidate.counts)}; ` +
        `binding=${JSON.stringify(candidate.bindings[0])}; summary=${JSON.stringify(current)}`);
    });
    assert.equal(state.bindings[0]?.syncState, 'local-draft');

    await kernel.router.dispatch('novelforge.queueDirtyProposals', undefined, 'core.test');
    state = await waitFor(async () => {
      const candidate = await kernel.router.ask<NovelForgePanelState>(
        'novelforge.state',
        undefined,
        'core.test',
      );
      return candidate.counts['proposal-queued'] === 1 ? candidate : undefined;
    }, 2_000);
    const queued = state.bindings[0]!;
    assert.ok(queued.pendingRequestId);
    const request = JSON.parse(await root.read([
      'requests',
      `${queued.pendingRequestId}.json`,
    ])) as NovelForgeChangeRequest;
    assert.equal(request.base_revision, 2);
    assert.equal(request.candidate_body.endsWith('画布作者补充：钥匙有裂纹。'), true);
    assert.equal(request.canvas_node_id, queued.canvasNodeId);

    await seedSingleArtifact(root, {
      revision: 3,
      authorityDigest: `sha256:${'4'.repeat(64)}`,
      title: '雨夜钥匙（Runtime 再更新）',
      body: 'Runtime 侧的新事实必须保留。',
    });
    await kernel.router.dispatch('novelforge.sync', undefined, 'core.test');
    state = await waitFor(async () => {
      const candidate = await kernel.router.ask<NovelForgePanelState>(
        'novelforge.state',
        undefined,
        'core.test',
      );
      return candidate.counts.conflict === 1 ? candidate : undefined;
    }, 2_000);
    assert.equal(state.bindings[0]?.artifactRevision, 3);
    assert.match(state.bindings[0]?.conflictReason ?? '', /均已修改/u);
    assert.equal(
      (await readNodeBody(kernel, queued.canvasNodeId)).endsWith('画布作者补充：钥匙有裂纹。'),
      true,
    );
  } finally {
    disposeStatus();
    await kernel.plugins.stop('novelforge');
  }
});

test('NovelForge connector restores projects, syncs artifacts and submits review-only proposals', async () => {
  const root = new MemoryDirectory('fallback-directory');
  await seedSingleArtifact(root, {
    revision: 1,
    authorityDigest: `sha256:${'8'.repeat(64)}`,
    title: '连接器素材卡',
    body: '连接器读取的权威正文。',
  });
  const manifest = JSON.parse(await root.read(['manifest.json'])) as NovelForgeManifest;
  const artifact = JSON.parse(await root.read(['artifacts', 'card.json'])) as Record<string, unknown>;
  const submitted: NovelForgeChangeRequest[] = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (input, init) => {
    const url = new URL(String(input));
    const body = JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown>;
    let result: unknown;
    if (url.pathname === '/v1/connector/health') {
      result = { status: 'READY', protocol: 'novelforge-canvas-local/2', model: 'novelforge-codex' };
    } else if (url.pathname === '/v1/runtime/projects') {
      result = { protocol: 'novelforge-canvas-runtime/2', projects: [manifest.project] };
    } else if (url.pathname === '/v1/runtime/snapshot') {
      result = {
        protocol: 'novelforge-canvas-runtime/2',
        manifest,
        artifacts: [artifact],
        receipts: [],
        cursor: body.cursor,
        next_cursor: null,
        total_entries: 1,
      };
    } else if (url.pathname === '/v1/runtime/proposals') {
      submitted.push(...body.requests as NovelForgeChangeRequest[]);
      result = { protocol: 'novelforge-canvas-runtime/2', processed: submitted.length, receipts: [] };
    } else {
      return new Response('not found', { status: 404 });
    }
    return new Response(JSON.stringify(result), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  };
  const directoryProvider: PluginDefinition = {
    manifest: defineManifest('novelforge-test-directory-connector', 'NovelForge 兼容目录', {
      providesCapabilities: [EXTERNAL_PROJECT_DIRECTORY_CAPABILITY],
    }),
    start(context) {
      context.capabilities.provide<undefined, FileDirectoryTarget>({
        key: EXTERNAL_PROJECT_DIRECTORY_CAPABILITY,
        invoke: () => root,
      });
    },
  };
  const kernel = new ApplicationKernel([
    directoryProvider,
    createTextNodePlugin(),
    createNovelForgePlugin(),
  ], { persistenceLaunchPolicy: 'fresh-session' });
  try {
    await kernel.start();
    await kernel.router.dispatch('novelforge.connector.configure', {
      endpoint: 'http://127.0.0.1:32147',
      pairingToken: 'A'.repeat(43),
    }, 'core.test');
    const online = await waitFor(async () => {
      const state = await kernel.router.ask<NovelForgePanelState>('novelforge.state', undefined, 'core.test');
      return state.connector.online ? state : undefined;
    });
    assert.equal(online.connector.projects[0]?.title, '联调书');
    await kernel.router.dispatch('novelforge.connector.selectProject', {
      projectId: manifest.project.project_id,
    }, 'core.test');
    let state = await waitFor(async () => {
      const candidate = await kernel.router.ask<NovelForgePanelState>('novelforge.state', undefined, 'core.test');
      return candidate.bindings.length === 1 && candidate.counts.synced === 1 ? candidate : undefined;
    });
    assert.equal(state.connectionMode, 'connector');
    const binding = state.bindings[0]!;
    const summary = (await kernel.capabilities.request<ContentSummary[]>(
      'content.summariesById@1', { nodeIds: [binding.canvasNodeId] },
    ))[0]!;
    await kernel.router.dispatch('content.applyDelta', {
      nodeId: binding.canvasNodeId,
      start: summary.length,
      deleteCount: 0,
      insert: '画布候选补充。',
      expectedRevision: summary.revision,
    }, 'core.test');
    await waitFor(async () => {
      const candidate = await kernel.router.ask<NovelForgePanelState>('novelforge.state', undefined, 'core.test');
      return candidate.counts['local-draft'] === 1 ? candidate : undefined;
    });
    await kernel.router.dispatch('novelforge.queueDirtyProposals', undefined, 'core.test');
    state = await waitFor(async () => {
      const candidate = await kernel.router.ask<NovelForgePanelState>('novelforge.state', undefined, 'core.test');
      return candidate.counts['proposal-queued'] === 1 ? candidate : undefined;
    });
    assert.equal(submitted.length, 1);
    assert.equal(submitted[0]?.project_id, manifest.project.project_id);
    assert.match(submitted[0]?.candidate_body ?? '', /画布候选补充/u);
    assert.equal(state.bindings[0]?.syncState, 'proposal-queued');
  } finally {
    globalThis.fetch = originalFetch;
    await kernel.plugins.stop('novelforge').catch(() => undefined);
  }
});

async function seedSingleArtifact(
  root: MemoryDirectory,
  input: { revision: number; authorityDigest: string; title: string; body: string },
): Promise<void> {
  const contentDigest = await digestNovelForgeText(input.title, input.body);
  const entry = {
    entry_id: 'material-card:CARD-1',
    artifact_id: 'CARD-1',
    artifact_type: 'MATERIAL_CARD',
    artifact_revision: input.revision,
    authority_digest: input.authorityDigest,
    content_digest: contentDigest,
    authority_status: 'ACTIVE',
    locked: false,
    editable_mode: 'DIRECT_AUTHOR_COMMIT' as const,
    chapter: null,
    card_id: 'CARD-1',
    file_path: 'artifacts/card.json',
    x: -720,
    y: 4400,
  };
  const project = {
    project_id: 'BOOK-1',
    title: '联调书',
    chapter_count: 200,
    stage: 'CREATED',
    workflow_status: 'PENDING',
    updated_at: `2026-10-19T00:00:0${input.revision}.000Z`,
  };
  const artifact = {
    kind: NOVELFORGE_ARTIFACT_KIND,
    protocol_version: NOVELFORGE_PROTOCOL_VERSION,
    project_id: project.project_id,
    ...entry,
    title: input.title,
    body: input.body,
    metadata: { category: 'plot_fragment' },
  };
  const entries = [entry];
  const manifest: NovelForgeManifest = {
    kind: NOVELFORGE_EXCHANGE_KIND,
    protocol_version: NOVELFORGE_PROTOCOL_VERSION,
    schema: 'novelforge.canvas.exchange.v1',
    project,
    generated_at: `2026-10-19T00:00:1${input.revision}.000Z`,
    entries,
    snapshot_digest: await digestJson({ project, entries }),
  };
  await root.put(['manifest.json'], JSON.stringify(manifest));
  await root.put(['artifacts', 'card.json'], JSON.stringify(artifact));
}

async function readNodeBody(kernel: ApplicationKernel, nodeId: string): Promise<string> {
  const summary = (await kernel.capabilities.request<ContentSummary[]>(
    'content.summariesById@1',
    { nodeIds: [nodeId] },
  ))[0]!;
  const range = await kernel.capabilities.request<{ text: string }>('content.read@1', {
    nodeId,
    start: 0,
    length: summary.length,
  });
  return range.text;
}

async function waitFor<T>(
  read: () => Promise<T | undefined>,
  timeoutMs = 1_000,
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = await read();
    if (value !== undefined) return value;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error('Timed out waiting for NovelForge integration state');
}

class MemoryDirectory implements FileDirectoryTarget {
  readonly directories = new Map<string, MemoryDirectory>();
  readonly files = new Map<string, string>();
  readonly name: string;

  constructor(name: string) { this.name = name; }

  async getDirectoryHandle(name: string, options?: { create?: boolean }): Promise<FileDirectoryTarget> {
    const existing = this.directories.get(name);
    if (existing) return existing;
    if (!options?.create) throw new DOMException('Not found', 'NotFoundError');
    const created = new MemoryDirectory(name);
    this.directories.set(name, created);
    return created;
  }

  async getFileHandle(name: string, options?: { create?: boolean }): Promise<FileSaveTarget> {
    if (!this.files.has(name) && !options?.create) throw new DOMException('Not found', 'NotFoundError');
    if (!this.files.has(name)) this.files.set(name, '');
    return new MemoryFile(name, this);
  }

  async put(path: string[], value: string): Promise<void> {
    const parent = await this.resolveDirectory(path.slice(0, -1), true);
    parent.files.set(path.at(-1)!, value);
  }

  async read(path: string[]): Promise<string> {
    const parent = await this.resolveDirectory(path.slice(0, -1), false);
    const value = parent.files.get(path.at(-1)!);
    if (value === undefined) throw new DOMException('Not found', 'NotFoundError');
    return value;
  }

  private async resolveDirectory(path: string[], create: boolean): Promise<MemoryDirectory> {
    if (path.length === 0) return this;
    const [segment, ...remaining] = path;
    const child = await this.getDirectoryHandle(segment!, { create }) as MemoryDirectory;
    return child.resolveDirectory(remaining, create);
  }
}

class MemoryFile implements FileSaveTarget {
  readonly name: string;
  private readonly directory: MemoryDirectory;

  constructor(name: string, directory: MemoryDirectory) {
    this.name = name;
    this.directory = directory;
  }

  async getFile(): Promise<File> {
    const text = this.directory.files.get(this.name) ?? '';
    return {
      size: new TextEncoder().encode(text).byteLength,
      text: async () => text,
    } as File;
  }

  async createWritable(): Promise<FileWritableTarget> {
    let pending = '';
    return {
      write: async (data) => { pending = await data.text(); },
      close: async () => { this.directory.files.set(this.name, pending); },
      abort: async () => { pending = ''; },
    };
  }
}
