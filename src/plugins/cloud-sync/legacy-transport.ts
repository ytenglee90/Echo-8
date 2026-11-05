import { isRecord } from '../../core/contracts.ts';
import { CLOUD_CONTENT_CHUNK_NAMESPACE, type CloudBootstrap, type CloudCheckpoint, type CloudStorageUsage, type CloudOperation } from '../../cloud/contracts.ts';
import type { TransactionCommitRecord } from '../../protocols/state.ts';
import type { ProjectSource } from '../../protocols/files.ts';
const CHUNK_REFERENCE = '__echo8ContentChunkRef';
export function externalizeCloudCommit(commit: TransactionCommitRecord): {
  commit: TransactionCommitRecord;
  chunks: Array<{ id: string; value: unknown }>;
} {
  const chunks: Array<{ id: string; value: unknown }> = [];
  const externalize = (patches: TransactionCommitRecord['forward']) => patches.map((patch) => {
    if (patch.op !== 'set' || patch.domain !== 'document' || patch.namespace !== CLOUD_CONTENT_CHUNK_NAMESPACE) return patch;
    chunks.push({ id: patch.key, value: patch.value });
    return { ...patch, value: { [CHUNK_REFERENCE]: patch.key } };
  });
  return {
    commit: { ...structuredClone(commit), forward: externalize(commit.forward), inverse: externalize(commit.inverse) },
    chunks,
  };
}

export function hydrateRemoteDocument(bootstrap: CloudBootstrap): CloudCheckpoint['document'] {
  const document = structuredClone(bootstrap.checkpoint?.document ?? { revision: 0, namespaces: {} });
  document.namespaces=Object.assign(Object.create(null),document.namespaces);
  for(const namespace of Object.keys(document.namespaces))document.namespaces[namespace]=Object.assign(Object.create(null),document.namespaces[namespace]);
  const chunks = new Map(bootstrap.chunks.map((chunk) => [chunk.id, chunk.value]));
  document.namespaces[CLOUD_CONTENT_CHUNK_NAMESPACE] = Object.fromEntries(chunks);
  for (const operation of bootstrap.operations) applyOperation(document, operation, chunks);
  return document;
}

function applyOperation(
  document: CloudCheckpoint['document'],
  operation: CloudOperation,
  chunks: Map<string, unknown>,
) {
  let changed = false;
  for (const patch of operation.commit.forward) {
    if (patch.domain !== 'document') continue;
    const namespace = document.namespaces[patch.namespace] ?? Object.create(null);
    document.namespaces[patch.namespace] = namespace;
    if (patch.op === 'delete') delete namespace[patch.key];
    else namespace[patch.key] = hydrateChunkReference(patch.value, chunks);
    changed = true;
  }
  if (changed) document.revision += 1;
}

function hydrateChunkReference(value: unknown, chunks: Map<string, unknown>): unknown {
  if (!isRecord(value) || typeof value[CHUNK_REFERENCE] !== 'string') return value;
  const id = value[CHUNK_REFERENCE];
  if (!chunks.has(id)) throw new Error(`云端正文分块缺失：${id}`);
  return structuredClone(chunks.get(id));
}

function dedupeChunks(chunks: Array<{ id: string; value: unknown }>) {
  return [...new Map(chunks.map((chunk) => [chunk.id, chunk])).values()];
}

function chunkBatches(chunks: Array<{ id: string; value: unknown }>): Array<Array<{ id: string; value: unknown }>> {
  const batches: Array<Array<{ id: string; value: unknown }>> = [];
  let current: Array<{ id: string; value: unknown }> = [];
  let bytes = 0;
  for (const chunk of chunks) {
    const size = new TextEncoder().encode(JSON.stringify(chunk)).byteLength;
    if (current.length && (current.length >= 32 || bytes + size > 8 * 1024 * 1024)) {
      batches.push(current);
      current = [];
      bytes = 0;
    }
    current.push(chunk);
    bytes += size;
  }
  if (current.length) batches.push(current);
  return batches;
}


/** Read/write compatibility for release 1–4 installations; new books never use this wire log. */
export async function saveLegacyBook(input: {
 request: <T>(path:string,init?:RequestInit)=>Promise<T>; source:()=>Promise<ProjectSource>;
 projectId:string; deviceId:string; leaseId:string; baseRevision:number;
 commits:TransactionCommitRecord[]; forceCheckpoint:boolean;
}) {
 const commits=input.commits.slice(0,200).map(externalizeCloudCommit);
 const captured=input.forceCheckpoint&&input.commits.length<=200?await input.source():undefined;
 const chunks=dedupeChunks([...(captured?Object.entries(captured.document.namespaces.textContentChunk??{}).map(([id,value])=>({id,value})):[]),...commits.flatMap(item=>item.chunks)]);
 let checkpoint:CloudCheckpoint|undefined;
 if(captured){captured.document.namespaces.textContentChunk={};checkpoint={formatVersion:1,savedAt:Date.now(),...captured,contentChunkIds:chunks.map(chunk=>chunk.id)};}
 const identity={deviceId:input.deviceId,leaseId:input.leaseId};
 for(const batch of chunkBatches(chunks))await input.request('/v1/projects/'+encodeURIComponent(input.projectId)+'/chunks',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({...identity,chunks:batch})});
 const result=await input.request<{accepted:number;headRevision:number;checkpointRevision:number;lease:{expiresAt:number};storage?:CloudStorageUsage}>('/v1/projects/'+encodeURIComponent(input.projectId)+'/sync',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({...identity,baseRevision:input.baseRevision,commits:commits.map(item=>item.commit),checkpoint,chunks:[]})});
 return {...result,captured:Boolean(captured)};
}
