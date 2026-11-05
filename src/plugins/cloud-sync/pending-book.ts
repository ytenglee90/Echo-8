import type { TransactionCommitRecord } from '../../protocols/state.ts';

export type PendingBookChange = TransactionCommitRecord & { documentRevision?: number };

/** Current values only; local history remains in the kernel recovery journal. */
export function addPendingBookChange(current: PendingBookChange[], record: TransactionCommitRecord, documentRevision?: number): PendingBookChange[] {
  const next: PendingBookChange = { ...record, documentRevision, inverse: [], forward: record.forward.filter(patch => patch.domain === 'document') };
  const keys = new Set(next.forward.map(patch => JSON.stringify([patch.namespace, patch.key])));
  const previous = current.map(item => ({ ...item, forward: item.forward.filter(patch => !keys.has(JSON.stringify([patch.namespace, patch.key]))) }))
    .filter(item => item.forward.length > 0 || item.label === '本机未上传修改');
  if (previous.some(item => item.forward.length === 0) || previous.length >= 256) return [{
    ...next, forward: [], label: '本机未上传修改',
  }];
  return [...previous, next];
}
