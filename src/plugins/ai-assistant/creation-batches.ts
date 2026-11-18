import type { PluginContext } from '../../core/contracts.ts';
import type { CanvasControlAdmission, CanvasControlReceipt } from '../../protocols/canvas-control.ts';
import { naturalCanvasOperation } from '../../services/ai-task-route.ts';
import { parseCanvasControlPlan } from '../../services/canvas-control-validation.ts';
import { normalizeCanvasTitle } from '../../services/canvas-titles.ts';
import type { ContentSummary } from '../../protocols/content.ts';

export const MAX_LOCAL_CREATIONS = 400;
export const CREATION_BATCH_SIZE = 80;

/** Independent creation only; related edits retain the atomic controller path. */
export async function runCreationBatches(context: PluginContext, input: CanvasControlAdmission, instructions: string[],
  signal: AbortSignal, progress: (completed: number, total: number, batches: number) => void): Promise<string> {
  if (instructions.length <= CREATION_BATCH_SIZE || instructions.length > MAX_LOCAL_CREATIONS ||
    instructions.some(text => naturalCanvasOperation(text)?.kind !== 'create')) throw new Error('自动分批只接受已完整解析的独立新建任务。');
  const batchCount = Math.ceil(instructions.length / CREATION_BATCH_SIZE);
  const previousBatches = new Map<number, CanvasControlReceipt>();
  const titles = new Set<string>();
  const existing = new Set((await context.capabilities.request<ContentSummary[]>('content.summaries@1', undefined, signal)).map(node => normalizeCanvasTitle(node.title)));
  for (let offset = 0; offset < instructions.length; offset += CREATION_BATCH_SIZE) {
    const previous = await context.capabilities.request<CanvasControlReceipt | undefined>('canvasControl.receipt@1',
      { sessionId: input.sessionId, preparationId: `${input.preparationId}:batch-${offset / CREATION_BATCH_SIZE + 1}` }, signal);
    if (previous) {
      if (!['applied', 'pending'].includes(previous.status)) throw new Error('此前批次已撤销、变化或取消，请作为新任务重新发送。');
      previousBatches.set(offset, previous);
    }
    for (const text of instructions.slice(offset, offset + CREATION_BATCH_SIZE)) {
      const operation = naturalCanvasOperation(text);
      if (operation?.kind !== 'create' || operation.names.length) throw new Error('自动分批只接受独立新建任务。');
      const title = normalizeCanvasTitle(operation.title);
      if (titles.has(title) || !previous && existing.has(title)) throw new Error(`分批任务中的标题「${operation.title}」已被使用，请更换名称。画布尚未修改。`);
      titles.add(title);
    }
  }
  let completed = 0;
  let pending = 0;
  for (let offset = 0; offset < instructions.length; offset += CREATION_BATCH_SIZE) {
    signal.throwIfAborted();
    const batch = instructions.slice(offset, offset + CREATION_BATCH_SIZE);
    const admission = { ...input, preparationId: `${input.preparationId}:batch-${offset / CREATION_BATCH_SIZE + 1}` };
    try {
      const previous = previousBatches.get(offset);
      if (previous) {
        if (previous.status === 'applied') completed += batch.length;
        else if (previous.status === 'pending') pending += batch.length;
        else throw new Error('此前批次已撤销、变化或取消，请作为新任务重新发送。');
        progress(completed, instructions.length, batchCount);
        continue;
      }
      const local = await context.capabilities.request<{ handled: boolean; text?: string }>('canvasControl.localPlan@2',
        { ...admission, instructions: batch }, signal);
      if (!local.handled || !local.text) throw new Error('新建操作能力不可用。');
      const plan = parseCanvasControlPlan(local.text);
      if (plan.actions.length !== batch.length || plan.actions.some(action => action.type !== 'create-node')) throw new Error(plan.answer ?? '新建计划与请求数量不一致。');
      signal.throwIfAborted();
      const offered = await context.commands.dispatch('canvasControl.offer@1', { ...admission, text: local.text, complete: true });
      if (offered.directPlanId) {
        signal.throwIfAborted();
        await context.commands.dispatch('canvasControl.generate@1', { id: offered.directPlanId });
        const receipt = await context.capabilities.request<CanvasControlReceipt | undefined>('canvasControl.receipt@1',
          { sessionId: input.sessionId, preparationId: admission.preparationId }, signal);
        if (receipt?.status !== 'applied') throw new Error('本批未完成提交，请查看画布操作记录。');
        completed += batch.length;
      } else pending += batch.length;
      progress(completed, instructions.length, batchCount);
    } catch (error) {
      if (signal.aborted) throw error;
      throw new Error(`分批新建停止：已创建 ${completed}/${instructions.length} 个节点，${pending} 个待确认。已提交批次可逐批撤销。${error instanceof Error ? error.message : String(error)}`, { cause: error });
    }
  }
  return pending ? `已创建 ${completed} 个节点，另有 ${pending} 个节点分批待确认。共 ${batchCount} 批，每批应用后可单独撤销。` :
    `已创建 ${completed} 个节点，共 ${batchCount} 批。每批可单独撤销，全部撤销需要 ${batchCount} 次。`;
}
