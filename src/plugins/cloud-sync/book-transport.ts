import { inspectBook, planBook, restoreBook } from '../../../cloud/data-worker/book-format.js';
import type { CloudBootstrap, CloudProjectSummary } from '../../cloud/contracts.ts';
import type { ProjectSource } from '../../protocols/files.ts';
import type { TransactionCommitRecord } from '../../protocols/state.ts';

export type BookPlan = Awaited<ReturnType<typeof planBook>>;
type Block = Awaited<ReturnType<typeof import('../../../cloud/data-worker/book-format.js').encodeBlock>>;
type Request = <T>(path: string, init?: RequestInit) => Promise<T>;
interface Head { revision: number; rootHash: string; documentRevision: number; savedAt: number; readerId: string }
const json = (value: unknown, method = 'POST'): RequestInit => ({ method, headers: { 'content-type': 'application/json' }, body: JSON.stringify(value) });

/** Immutable book plans contain references, never a retained second copy of body text. */
export class BookTransport {
  private plans = new Map<string, BookPlan>();
  private attempts=new Map<string,{plan:BookPlan;saveId:string;baseRevision:number;commits:string[]}>();
  private readonly request:Request;
  constructor(request:Request) {this.request=request;}

  clear() { this.plans.clear();this.attempts.clear(); }

  async bootstrap(projectId: string): Promise<CloudBootstrap | undefined> {
    const prefix = `/v2/projects/${encodeURIComponent(projectId)}`;
    const response = await this.request<{ project: CloudProjectSummary; head: Head | null }>(`${prefix}/head`);
    if (!response.head) return undefined;
    const head = response.head;
    const blocks = new Map<string, Block>();
    const fetchBlocks = async (hashes: string[]) => {
      for (let offset = 0; offset < hashes.length; offset += 64) {
        const response = await this.request<{ blocks: Block[] }>(`${prefix}/blocks`, json({ readerId: head.readerId, hashes: hashes.slice(offset, offset + 64) }));
        for (const block of response.blocks) blocks.set(block.hash, block);
      }
    };
    const get = async (hash: string) => {
      if (!blocks.has(hash)) await fetchBlocks([hash]);
      const block = blocks.get(hash);
      if (!block) throw new Error('云端书籍分块缺失，已停止载入');
      return block;
    };
    try {
      // Fetch manifest pages together; inspectBook still verifies every hash.
      const rootBlock = await get(head.rootHash);
      const { decodeBlock } = await import('../../../cloud/data-worker/book-format.js');
      const root = JSON.parse(new TextDecoder().decode(await decodeBlock(rootBlock))) as { pages: string[] };
      if (!Array.isArray(root.pages) || root.pages.length > 2_000) throw new Error('云端书籍清单无效');
      await fetchBlocks(root.pages);
      const inspected = await inspectBook(head.rootHash, get);
      const missing = inspected.hashes.filter(hash => !blocks.has(hash));
      await fetchBlocks(missing);
      const source = await restoreBook(inspected, get) as ProjectSource;
      const plan = { ...inspected, blocks: new Map() } as BookPlan;
      this.plans.clear();
      this.plans.set(projectId, plan);
      const chunks = Object.entries(source.document.namespaces.textContentChunk ?? {}).map(([id, value]) => ({ id, value }));
      source.document.namespaces.textContentChunk = {};
      return { project: response.project, checkpointRevision: head.revision,
        checkpoint: { formatVersion: 1, savedAt: head.savedAt, ...source, contentChunkIds: chunks.map(chunk => chunk.id) }, chunks, operations: [] };
    } finally {
      blocks.clear();
      await this.request(`${prefix}/reads`, json({ readerId: head.readerId }, 'DELETE')).catch(() => undefined);
    }
  }

  async save(input: {
    projectId: string; baseRevision: number; deviceId: string; leaseId: string;
    commits: Array<TransactionCommitRecord & {documentRevision?:number}>; source(): Promise<ProjectSource>; catalog(): Promise<ProjectSource['plugins']>;
  }): Promise<{ revision: number; rootHash: string; savedAt: number; documentRevision: number; uploadedBytes: number; acceptedIds:string[]; unchanged?: boolean; storage?: import('../../cloud/contracts.ts').CloudStorageUsage }> {
    const uncertain=this.attempts.get(input.projectId);
    if(uncertain){
      const prefix=`/v2/projects/${encodeURIComponent(input.projectId)}`;
      const current=await this.request<{head:Head|null}>(`${prefix}/head`);
      if(current.head){
        await this.request(`${prefix}/reads`,json({readerId:current.head.readerId},'DELETE')).catch(()=>undefined);
        if(current.head.rootHash===uncertain.plan.rootHash&&current.head.revision===uncertain.baseRevision+1){
          uncertain.plan.blocks.clear();this.plans.clear();this.plans.set(input.projectId,uncertain.plan);this.attempts.delete(input.projectId);
          return {...current.head,uploadedBytes:0,acceptedIds:uncertain.commits};
        }
      }
    }
    const previous = this.plans.get(input.projectId);
    const incremental = previous && input.commits.length && input.commits.every(commit => commit.forward.length > 0);
    const source = uncertain ? undefined : incremental ? {
      document: { revision: input.commits.at(-1)?.documentRevision ?? previous.root.documentRevision + input.commits.filter(commit => commit.forward.some(patch => patch.domain === 'document')).length, namespaces: {} },
      plugins: await input.catalog(),
    } : await input.source();
    const plan = uncertain?.plan ?? await planBook(source!, incremental ? previous : undefined,
      incremental ? input.commits.flatMap(commit => commit.forward) : undefined) as BookPlan;
    if (previous?.rootHash === plan.rootHash) return { revision: input.baseRevision, rootHash: plan.rootHash,
      savedAt: Date.now(), documentRevision: plan.root.documentRevision, uploadedBytes: 0, unchanged: true,acceptedIds:input.commits.map(commit=>commit.id) };
    const prefix = `/v2/projects/${encodeURIComponent(input.projectId)}`;
    const saveId = uncertain?.saveId ?? `save-${crypto.randomUUID()}`;
    const acceptedIds=uncertain?.commits??input.commits.map(commit=>commit.id);
    this.attempts.set(input.projectId,{plan,saveId,baseRevision:input.baseRevision,commits:acceptedIds});
    const identity = { saveId, deviceId: input.deviceId, leaseId: input.leaseId };
    const staged = await this.request<{ missing: string[] }>(`${prefix}/uploads`, json({ ...identity,
      baseRevision: input.baseRevision, rootHash: plan.rootHash, hashes: plan.hashes,
      estimatedBytes: [...plan.blocks.values()].reduce((sum, block) => sum + new TextEncoder().encode(block.data).length, 0),
    }));
    // If an earlier session's cache cannot supply a missing block, rebuild
    // from authoritative current content; never commit an incomplete manifest.
    let supply = plan.blocks;
    if (staged.missing.some(hash => !supply.has(hash))) {
      const full = await planBook(await input.source()) as BookPlan;
      supply = new Map([...full.blocks, ...plan.blocks]);
      if (staged.missing.some(hash => !supply.has(hash))) throw new Error('本机保存基线已变化，请重试；修改仍保留');
    }
    let uploadedBytes = 0;
    for (let offset = 0; offset < staged.missing.length; offset += 8) {
      const batch = staged.missing.slice(offset, offset + 8).map(hash => supply.get(hash)!);
      await this.request(`${prefix}/blocks`, json({ ...identity, blocks: batch }, 'PUT'));
      uploadedBytes += batch.reduce((sum, block) => sum + new TextEncoder().encode(block.data).length, 0);
    }
    const result = await this.request<{ revision: number; rootHash: string; savedAt: number; documentRevision: number; storage?: import('../../cloud/contracts.ts').CloudStorageUsage }>(`${prefix}/commit`, json(identity));
    if (result.rootHash !== plan.rootHash) throw new Error('云端保存确认与本机不一致，修改已保留');
    plan.blocks.clear();
    this.plans.clear(); this.plans.set(input.projectId, plan);
    this.attempts.delete(input.projectId);
    return { ...result, uploadedBytes,acceptedIds };
  }
}
