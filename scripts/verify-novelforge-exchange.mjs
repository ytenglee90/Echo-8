import { mkdir, readFile, stat, writeFile } from 'node:fs/promises';
import { basename, join, resolve } from 'node:path';

import {
  digestJson,
  digestNovelForgeText,
  readNovelForgeExchange,
  writeNovelForgeRequest,
} from '../src/plugins/novelforge/exchange.ts';
import {
  NOVELFORGE_PROTOCOL_VERSION,
  NOVELFORGE_REQUEST_KIND,
} from '../src/protocols/novelforge.ts';

class NodeDirectory {
  constructor(path, writable = false) {
    this.path = path;
    this.name = basename(path);
    this.writable = writable;
  }

  async getDirectoryHandle(name, options = {}) {
    const path = join(this.path, name);
    let info = await stat(path).catch(() => undefined);
    if (!info && options.create && this.writable) {
      await mkdir(path);
      info = await stat(path);
    }
    if (!info?.isDirectory()) throw new DOMException('Not found', 'NotFoundError');
    return new NodeDirectory(path, this.writable);
  }

  async getFileHandle(name, options = {}) {
    const path = join(this.path, name);
    const info = await stat(path).catch(() => undefined);
    if (!info && options.create && this.writable) return new NodeFile(path, name, 0, true);
    if (!info?.isFile()) throw new DOMException('Not found', 'NotFoundError');
    return new NodeFile(path, name, info.size, this.writable);
  }
}

class NodeFile {
  constructor(path, name, size, writable) {
    this.path = path;
    this.name = name;
    this.size = size;
    this.writable = writable;
  }

  async getFile() {
    return {
      size: this.size,
      text: async () => readFile(this.path, 'utf8'),
    };
  }

  async createWritable() {
    if (!this.writable) throw new Error('验证器是只读的');
    let pending;
    return {
      write: async (data) => { pending = await data.text(); },
      close: async () => {
        if (pending === undefined) throw new Error('没有待写入的 NovelForge 请求');
        await writeFile(this.path, pending, 'utf8');
      },
      abort: async () => { pending = undefined; },
    };
  }
}

const input = process.argv[2];
if (!input) {
  process.stderr.write('用法: pnpm run verify:novelforge-exchange -- <exchange目录> [--write-probe]\n');
  process.exitCode = 2;
} else {
  const directory = resolve(input);
  const info = await stat(directory).catch(() => undefined);
  if (!info?.isDirectory()) {
    process.stderr.write(`NovelForge exchange 目录不存在: ${directory}\n`);
    process.exitCode = 2;
  } else {
    const target = new NodeDirectory(directory, process.argv.includes('--write-probe'));
    const exchange = await readNovelForgeExchange(target);
    let request;
    if (process.argv.includes('--write-probe')) {
      const artifact = exchange.artifacts.find((candidate) =>
        candidate.artifact_type === 'MATERIAL_CARD' &&
        candidate.editable_mode === 'DIRECT_AUTHOR_COMMIT'
      );
      if (!artifact) throw new Error('没有可用于协议探针的直接作者提交素材卡');
      const candidateBody = `${artifact.body}\n\n[画布协议联调探针：仅形成待审提案]`;
      const candidateDigest = await digestNovelForgeText(artifact.title, candidateBody);
      const identityDigest = await digestJson({
        projectId: artifact.project_id,
        entryId: artifact.entry_id,
        baseDigest: artifact.authority_digest,
        candidateDigest,
      });
      const requestId = `CANVAS-REQ-${identityDigest.slice(7, 39)}`;
      request = {
        kind: NOVELFORGE_REQUEST_KIND,
        protocol_version: NOVELFORGE_PROTOCOL_VERSION,
        request_id: requestId,
        project_id: artifact.project_id,
        entry_id: artifact.entry_id,
        artifact_type: artifact.artifact_type,
        artifact_id: artifact.artifact_id,
        base_revision: artifact.artifact_revision,
        base_digest: artifact.authority_digest,
        base_content_digest: artifact.content_digest,
        canvas_node_id: 'integration-probe-node',
        canvas_node_revision: 1,
        candidate_title: artifact.title,
        candidate_body: candidateBody,
        candidate_digest: candidateDigest,
        created_at: new Date().toISOString(),
      };
      await writeNovelForgeRequest(target, requestId, request);
    }
    process.stdout.write(`${JSON.stringify({
      project_id: exchange.manifest.project.project_id,
      title: exchange.manifest.project.title,
      entries: exchange.artifacts.length,
      snapshot_digest: exchange.manifest.snapshot_digest,
      protocol_version: exchange.manifest.protocol_version,
      ...(request ? {
        probe_request_id: request.request_id,
        probe_candidate_digest: request.candidate_digest,
      } : {}),
    })}\n`);
  }
}
