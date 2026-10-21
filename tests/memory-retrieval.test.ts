import assert from 'node:assert/strict';
import test from 'node:test';
import type { AIMemoryClaimRecord, AIMemoryIndexRecord } from '../src/protocols/ai.ts';
import {
  detectMemoryConflicts,
  matchConversationMemories,
  memoryQueryBranches,
} from '../src/plugins/ai-assistant/memory-retrieval.ts';
import { expandMemoryClaimRelations } from '../src/plugins/ai-assistant/memory-claim-graph.ts';

function memory(
  sourceId: string,
  overrides: Partial<AIMemoryIndexRecord> = {},
): AIMemoryIndexRecord {
  return {
    sessionId: `session:${sourceId}`,
    sourceId,
    title: sourceId,
    schemaVersion: 2,
    indexNodeId: `index:${sourceId}`,
    sourceRevision: 1,
    sourceLength: 100,
    summary: '服务器发生内存溢出并返回 502 报错',
    keywords: ['服务器', '内存溢出', '502'],
    anchors: [{ term: '服务器', start: 10, length: 80 }],
    createdAt: 1,
    ...overrides,
  };
}

function claim(
  id: string,
  kind: AIMemoryClaimRecord['kind'],
  value: string,
  overrides: Partial<AIMemoryClaimRecord> = {},
): AIMemoryClaimRecord {
  return {
    id,
    kind,
    status: kind === 'branch' ? 'branch' : kind === 'deprecate' ? 'deprecated' : 'current',
    subject: '超时',
    value,
    start: 0,
    length: 8,
    authority: 'user-explicit',
    ...overrides,
  };
}

test('memory retrieval batches candidates and can force a selected memory without lexical overlap', () => {
  const indexes = Object.fromEntries(Array.from({ length: 60 }, (_, index) => {
    const item = memory(`memory:${index}`, {
      createdAt: index,
      summary: `服务器记录 ${index}`,
      keywords: ['服务器'],
    });
    return [item.sourceId, item];
  }));
  indexes['forced'] = memory('forced', { summary: '完全不同的主题', keywords: [], anchors: [] });

  const result = matchConversationMemories('全面整理服务器问题', indexes, new Set(['forced']));
  assert.equal(result.report.batchSize, 10);
  assert.equal(result.report.candidateLimit, 50);
  assert.equal(result.report.exhaustiveRequested, true);
  assert.equal(result.matches.some((match) => match.index.sourceId === 'forced'), true);
  assert.ok(result.report.batchesScanned > 1);
  assert.ok(result.matches.length <= 50);
  assert.ok(memoryQueryBranches('服务器、发布流程以及用户反馈').length >= 2);
});

test('memory retrieval anchors to an explicit formal claim when summaries omit its terms', () => {
  const formal = memory('formal', {
    summary: '', keywords: [], anchors: [],
    claims: [claim('production-timeout', 'confirm', '30 秒', {
      scope: '环境=生产', start: 72,
    })],
  });
  const unrelated = memory('unrelated', {
    summary: '生产发布窗口', keywords: ['生产'], anchors: [{ term: '生产', start: 8, length: 30 }],
  });
  const result = matchConversationMemories('生产环境的超时是多少？', {
    [formal.sourceId]: formal,
    [unrelated.sourceId]: unrelated,
  });
  const matched = result.matches.find((item) => item.index.sourceId === formal.sourceId);
  assert.ok(matched);
  assert.equal(matched.anchorStarts[0], 72);
  assert.equal(matched.coveredBranches.length, 1);
});

test('memory retrieval follows bounded, user-confirmed claim relations to original evidence', () => {
  const login = memory('overseas-login', {
    summary: '', keywords: [], anchors: [],
    claims: [claim('overseas-login-method', 'confirm', '邮箱登录', {
      subject: '登录方式', scope: '地区=海外', start: 12,
    })],
  });
  const authentication = memory('overseas-authentication', {
    summary: '', keywords: [], anchors: [],
    claims: [claim('overseas-authentication-link', 'confirm', '一次性链接', {
      subject: '身份验证', scope: '地区=海外', start: 56,
    })],
  });
  const candidate = memory('candidate-only', {
    summary: '', keywords: [], anchors: [],
    claims: [claim('candidate-authentication', 'confirm', '临时令牌', {
      subject: '身份验证', scope: '地区=海外', status: 'candidate', start: 80,
    })],
  });
  const deprecated = memory('deprecated-only', {
    summary: '', keywords: [], anchors: [],
    claims: [claim('deprecated-authentication', 'deprecate', '旧版短信', {
      subject: '身份验证', scope: '地区=海外', start: 92,
    })],
  });

  const result = matchConversationMemories('登录方式应该怎么设置？', {
    [login.sourceId]: login,
    [authentication.sourceId]: authentication,
    [candidate.sourceId]: candidate,
    [deprecated.sourceId]: deprecated,
  });
  const related = result.matches.find((item) => item.index.sourceId === authentication.sourceId);
  assert.ok(related);
  assert.ok(related.anchorStarts.includes(56));
  assert.equal(result.matches.some((item) => item.index.sourceId === candidate.sourceId), false);
  assert.equal(result.matches.some((item) => item.index.sourceId === deprecated.sourceId), false);
  assert.equal(result.report.relationshipSources, 1);
  assert.equal(result.report.relationshipEvidence, 1);
});

test('memory claim relation expansion is capped before it can flood retrieval', () => {
  const seed = memory('seed', {
    summary: '', keywords: [], anchors: [],
    claims: [claim('seed-login-method', 'confirm', '邮箱登录', {
      subject: '登录方式', scope: '地区=海外', start: 10,
    })],
  });
  const indexes: Record<string, AIMemoryIndexRecord> = { [seed.sourceId]: seed };
  for (let index = 0; index < 48; index += 1) {
    const related = memory(`related:${index}`, {
      createdAt: index + 2,
      summary: '', keywords: [], anchors: [],
      claims: [claim(`related:${index}`, 'confirm', `链接${index}`, {
        subject: `身份验证${index}`, scope: '地区=海外', start: index * 10,
      })],
    });
    indexes[related.sourceId] = related;
  }
  const result = matchConversationMemories('登录方式应该怎么设置？', indexes);
  assert.equal(result.report.relationshipEvidence, 24);
  assert.equal(result.report.relationshipSources, 24);
  assert.ok(result.matches.length <= 25);
});

test('memory claim relations never cross two different explicit scopes', () => {
  const production = memory('production', {
    claims: [claim('production-window', 'confirm', '周五', {
      subject: '部署窗口', scope: '环境=生产', start: 12,
    })],
  });
  const testEnvironment = memory('test', {
    claims: [claim('test-window', 'confirm', '随时', {
      subject: '部署窗口', scope: '环境=测试', start: 20,
    })],
  });
  const expansion = expandMemoryClaimRelations([['生产']], [production, testEnvironment]);
  assert.equal(expansion.matches.has(testEnvironment.sourceId), false);
  assert.equal(expansion.evidenceCount, 0);
});

test('memory conflict detection separates applicability scopes', () => {
  const conflicts = detectMemoryConflicts([
    memory('test', { claims: [claim('test-timeout', 'confirm', '5 秒', { scope: '环境=测试' })] }),
    memory('production', { claims: [claim('production-timeout', 'confirm', '30 秒', { scope: '环境=生产' })] }),
  ], '超时应该是多少');
  assert.deepEqual(conflicts, []);
});

test('memory conflict detection resolves an explicit modification but keeps true conflicts visible', () => {
  const resolved = detectMemoryConflicts([
    memory('old', { claims: [claim('old-timeout', 'confirm', '5 秒', { scope: '环境=生产' })] }),
    memory('new', { claims: [claim('new-timeout', 'modify', '30 秒', {
      previousValue: '5 秒',
      scope: '环境=生产',
    })] }),
  ], '生产环境超时');
  assert.equal(resolved.length, 1);
  assert.equal(resolved[0].resolution, 'resolved-by-explicit-modification');
  assert.equal(resolved[0].currentValue, '30 秒');

  const unresolved = detectMemoryConflicts([
    memory('first', { claims: [claim('first-timeout', 'confirm', '5 秒', { scope: '环境=生产' })] }),
    memory('second', { claims: [claim('second-timeout', 'confirm', '30 秒', { scope: '环境=生产' })] }),
  ], '生产环境超时');
  assert.equal(unresolved.length, 1);
  assert.equal(unresolved[0].resolution, 'unresolved');
});
