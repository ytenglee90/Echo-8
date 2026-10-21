import type {
  AIContextSource,
  AIPreparedContext,
  AIProposalRecord,
} from '../../protocols/ai.ts';
import { IconButton } from '../../ui/Icon.tsx';
import { operationLabel } from './operations.ts';
import type { AIWritebackMode } from './proposal-writeback.ts';
import {
  contextSourceReasonText,
  evidenceBoundaryText,
  formatAITimestamp,
  memoryIssueText,
} from './transcript-presentation.ts';

export function AIContextReview({
  prepared,
  providerConfigured,
  onConfirm,
  onReturn,
}: {
  prepared: AIPreparedContext;
  providerConfigured: boolean;
  onConfirm: () => void;
  onReturn: () => void;
}) {
  return (
    <section className="ai-context-preview ai-review-dialog" role="dialog" aria-label="需要确认的上下文检查">
      <header>
        <div><strong>这次需要确认</strong><span>{prepared.review?.message}</span></div>
        <em>{prepared.sources.length} 个来源</em>
      </header>
      {prepared.memoryRetrieval && <MemoryRetrievalReport prepared={prepared} />}
      {prepared.sources.length === 0 && <p>本次只发送你的要求，不附加画布正文。</p>}
      <div className="ai-source-list">
        {prepared.sources.map((source) => (
          <article key={`${source.sourceId}:${source.start}`}>
            <div><strong>{source.title}</strong><span>{contextSourceReasonText(source.reason)}</span></div>
            <p>{source.text}</p>
            <small>
              修订 {source.revision} · 发送 {source.length.toLocaleString()} 字符
              {source.estimatedTokens !== undefined ? ` · 约 ${source.estimatedTokens.toLocaleString()} token` : ''} · {evidenceBoundaryText(source.boundary)}
              {source.staleIndexRevision !== undefined ? ' · 已按当前原文重新核对' : ''}
            </small>
          </article>
        ))}
      </div>
      {(prepared.memoryConflicts?.length ?? 0) > 0 && (
        <div className="ai-memory-conflicts" role="alert">
          <strong>记忆版本检查</strong>
          {prepared.memoryConflicts!.map((conflict) => (
            <article key={conflict.key}>
              <div>
                <b>{conflict.subject}{conflict.scope ? `（${conflict.scope}）` : ''}</b>
                <span>{conflict.resolution === 'unresolved' ? '尚未解决' : '已有明确修改'}</span>
              </div>
              {conflict.evidence.map((evidence) => (
                <small key={evidence.claimId}>
                  {evidence.value} · {evidence.title}
                  {evidence.effectiveStatus === 'superseded' ? ' · 已被修改' : ''}
                  {evidence.effectiveStatus === 'deprecated' ? ' · 已废弃' : ''}
                  {evidence.effectiveStatus === 'competing' ? ' · 仍在冲突' : ''}
                </small>
              ))}
            </article>
          ))}
        </div>
      )}
      {(prepared.memoryIssues?.length ?? 0) > 0 && (
        <div className="ai-memory-conflicts" role="alert">
          <strong>记忆索引状态</strong>
          {prepared.memoryIssues!.map((issue) => (
            <small key={`${issue.sourceId}:${issue.reason}`}>
              {issue.title} · {memoryIssueText(issue)}
            </small>
          ))}
        </div>
      )}
      {!providerConfigured && <p className="ai-hint">上下文仍停留在本机；配置当前助手的模型后才能继续。</p>}
      <div className="ai-review-actions">
        <button type="button" className="ai-review-primary" onClick={onConfirm}>确认并继续</button>
        <button type="button" onClick={onReturn}>返回修改</button>
      </div>
    </section>
  );
}

function MemoryRetrievalReport({ prepared }: { prepared: AIPreparedContext }) {
  const retrieval = prepared.memoryRetrieval;
  if (!retrieval) return null;
  return (
    <div className="ai-retrieval-report" role="status">
      <strong>记忆检索</strong>
      <span>
        已读取 {retrieval.evidenceMemories} 份相关原文
        {retrieval.deferredMemories > 0
          ? `，另有 ${retrieval.deferredMemories} 份相关资料未放入本次上下文`
          : '，相关资料已全部放入本次上下文'}。
      </span>
      {retrieval.contextBudgetExhausted && <em>本次上下文容量已满，未放入的资料不会被悄悄截断。</em>}
      {(retrieval.incompleteBlocksSkipped ?? 0) > 0 && (
        <em>已跳过 {retrieval.incompleteBlocksSkipped} 个无法完整放入的片段，未发送半句话或半截代码。</em>
      )}
      <details>
        <summary>查看详细检索过程</summary>
        <div>
          <span>
            每批 {retrieval.batchSize} 份 · 已检索 {retrieval.batchesScanned} 批 ·
            命中 {retrieval.candidatesMatched} 份候选 · 可用 {retrieval.usableCandidates} 份
          </span>
          <span>
            索引覆盖 {retrieval.coveredBranches}/{retrieval.queryBranches} 个问题方向 ·
            完整原文覆盖 {retrieval.evidenceCoveredBranches ?? 0}/{retrieval.queryBranches}
          </span>
          {(retrieval.staleCandidates ?? 0) > 0 && (
            <span>
              发现 {retrieval.staleCandidates} 份旧索引 ·
              已按当前原文恢复 {retrieval.staleCandidatesRecovered ?? 0} 份
            </span>
          )}
          {(retrieval.relationshipEvidence ?? 0) > 0 && (
            <span>
              已通过用户确认事实的关联补充 {retrieval.relationshipSources ?? 0} 份候选 ·
              定位 {retrieval.relationshipEvidence} 个原文位置
            </span>
          )}
          <span>
            候选上限 {retrieval.candidateLimit} 份
            {retrieval.exhaustiveRequested ? ' · 本次执行了全面检索' : ''}
          </span>
          {prepared.contextBudget && (
            <span>
              参考资料预算约 {prepared.contextBudget.evidenceTokenLimit.toLocaleString()} token
              {prepared.contextBudget.modelContextWindowTokens
                ? ` · 当前模型上下文上限 ${prepared.contextBudget.modelContextWindowTokens.toLocaleString()} token`
                : ' · 使用保守默认上限'}
            </span>
          )}
        </div>
      </details>
    </div>
  );
}

export function AIWritebackReview({
  proposal,
  sources,
  mode,
  nodeId,
  onSelectionChange,
  onAccept,
  onDismiss,
}: {
  proposal: AIProposalRecord;
  sources: readonly AIContextSource[];
  mode: AIWritebackMode;
  nodeId: string;
  onSelectionChange: (mode: AIWritebackMode, nodeId: string) => void;
  onAccept: () => void;
  onDismiss: () => void;
}) {
  const textSources = sources.filter((source) => source.provider === 'text-node' && source.kind === 'text');
  return (
    <aside className={`ai-proposal ai-writeback-review ai-proposal-${proposal.status}`} role="dialog" aria-label="正文写回确认">
      <header>
        <strong>是否把回答写回正文？</strong>
        <span>{operationLabel(proposal.operation)} · {formatAITimestamp(proposal.createdAt)}</span>
      </header>
      <p>目标：{proposal.suggestedTarget?.title ?? '明确引用的文字节点'}。关闭或放弃后不会留下审查卡片，也不会创建新节点。</p>
      {proposal.status === 'pending' && (
        <div className="ai-proposal-actions">
          <select
            aria-label="AI 提案写入方式"
            value={mode}
            onChange={(event) => onSelectionChange(event.target.value as AIWritebackMode, nodeId)}
          >
            <option value="replace">替换已有节点全文</option>
            <option value="append">追加到已有节点</option>
          </select>
          <select
            aria-label="AI 提案目标节点"
            value={nodeId}
            onChange={(event) => onSelectionChange(mode, event.target.value)}
          >
            <option value="">选择目标节点…</option>
            {textSources.map((source) => (
              <option key={source.sourceId} value={source.sourceId}>{source.title} · 修订 {source.revision}</option>
            ))}
          </select>
          <IconButton
            icon="check"
            label="接受提案"
            className="primary-icon-button"
            disabled={!nodeId}
            onClick={onAccept}
          />
          <IconButton icon="dismiss" label="放弃提案" onClick={onDismiss} />
        </div>
      )}
    </aside>
  );
}
