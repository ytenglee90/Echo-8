import type { AIMemoryClaimKind } from '../../src/protocols/ai.ts';

export interface MemoryRetrievalEvaluationCase {
  name: string;
  prompt: string;
  memories: Array<{
    sourceId: string;
    summary: string;
    keywords: string[];
    scope?: string;
  }>;
  forcedSourceIds?: string[];
  expectedSourceIds: string[];
  forbiddenSourceIds?: string[];
}

export interface MemoryConflictEvaluationCase {
  name: string;
  prompt: string;
  memories: Array<{
    sourceId: string;
    createdAt: number;
    claims: Array<{
      kind: AIMemoryClaimKind;
      subject: string;
      value?: string;
      previousValue?: string;
      scope?: string;
    }>;
  }>;
  expected: 'none' | 'resolved' | 'unresolved';
  currentValue?: string;
}

export const MEMORY_RETRIEVAL_EVALUATION_CASES: MemoryRetrievalEvaluationCase[] = [
  {
    name: 'one relevant memory is recalled without unrelated leakage',
    prompt: '服务器故障的处理结论是什么？',
    memories: [
      { sourceId: 'incident', summary: '服务器故障与恢复过程', keywords: ['服务器', '故障'] },
      { sourceId: 'travel', summary: '海边旅行计划', keywords: ['海边', '旅行'] },
    ],
    expectedSourceIds: ['incident'],
    forbiddenSourceIds: ['travel'],
  },
  {
    name: 'compound questions cover independent branches',
    prompt: '综合服务器、发布流程、用户反馈，整理当前风险。',
    memories: [
      { sourceId: 'server', summary: '服务器容量', keywords: ['服务器'] },
      { sourceId: 'release', summary: '发布流程检查', keywords: ['发布流程'] },
      { sourceId: 'feedback', summary: '用户反馈汇总', keywords: ['用户反馈'] },
    ],
    expectedSourceIds: ['server', 'release', 'feedback'],
  },
  {
    name: 'an explicitly selected memory remains recallable without word overlap',
    prompt: '继续刚才的内容。',
    memories: [
      { sourceId: 'selected', summary: '完全不同的历史主题', keywords: ['旧主题'] },
    ],
    forcedSourceIds: ['selected'],
    expectedSourceIds: ['selected'],
  },
  {
    name: 'an exhaustive request scans beyond the first ten candidates',
    prompt: '全面整理所有服务器记录。',
    memories: Array.from({ length: 24 }, (_, index) => ({
      sourceId: `server-${index}`,
      summary: `服务器记录 ${index}`,
      keywords: ['服务器'],
    })),
    expectedSourceIds: ['server-0', 'server-12', 'server-23'],
  },
];

export const MEMORY_CONFLICT_EVALUATION_CASES: MemoryConflictEvaluationCase[] = [
  {
    name: 'different environments are not a conflict',
    prompt: '超时时间是多少？',
    memories: [
      { sourceId: 'test', createdAt: 1, claims: [{ kind: 'confirm', subject: '超时', value: '5秒', scope: '环境=测试' }] },
      { sourceId: 'prod', createdAt: 2, claims: [{ kind: 'confirm', subject: '超时', value: '30秒', scope: '环境=生产' }] },
    ],
    expected: 'none',
  },
  {
    name: 'an explicit modification supersedes the old value',
    prompt: '生产环境超时',
    memories: [
      { sourceId: 'old', createdAt: 1, claims: [{ kind: 'confirm', subject: '超时', value: '5秒', scope: '环境=生产' }] },
      { sourceId: 'new', createdAt: 2, claims: [{ kind: 'modify', subject: '超时', previousValue: '5秒', value: '30秒', scope: '环境=生产' }] },
    ],
    expected: 'resolved',
    currentValue: '30秒',
  },
  {
    name: 'a later confirmation can reopen a previously resolved conflict',
    prompt: '生产环境超时',
    memories: [
      { sourceId: 'old', createdAt: 1, claims: [{ kind: 'confirm', subject: '超时', value: '5秒', scope: '环境=生产' }] },
      { sourceId: 'changed', createdAt: 2, claims: [{ kind: 'modify', subject: '超时', previousValue: '5秒', value: '30秒', scope: '环境=生产' }] },
      { sourceId: 'reopened', createdAt: 3, claims: [{ kind: 'confirm', subject: '超时', value: '5秒', scope: '环境=生产' }] },
    ],
    expected: 'unresolved',
  },
  {
    name: 'named branches remain independent',
    prompt: '结局是谁？',
    memories: [
      { sourceId: 'a', createdAt: 1, claims: [{ kind: 'branch', subject: '凶手', value: '林川', scope: '结局A' }] },
      { sourceId: 'b', createdAt: 2, claims: [{ kind: 'branch', subject: '凶手', value: '周宁', scope: '结局B' }] },
    ],
    expected: 'none',
  },
];
