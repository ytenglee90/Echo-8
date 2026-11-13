import type { TextNodeCapabilityRuntime } from './capability-runtime.ts';
import type { CanvasControlNodeRequest, CanvasControlNodePlan } from '../../protocols/canvas-control.ts';
import type { ContentMutationPlan, ContentMovePlan, ContentRenamePlan, ContentSummary } from '../../protocols/content.ts';
import type { PatchOperation, EventDeclaration } from '../../protocols/state.ts';
import { validateCanvasControlActions } from '../../services/canvas-control-validation.ts';
import { assertNotAborted, yieldToMainThread } from '../../services/async-control.ts';
import { normalizeNodeTitle } from './title-policy.ts';
import { NODE_NAMESPACE, CONTENT_NAMESPACE, nodeHeight, nodePresentation, nodeResizeLimits, rememberedNodeSize, withRememberedNodeSize, isCanvasTextNode, type TextNodeRecord } from './operations.ts';
import type { TextContentRecord } from './content-storage.ts';

export function registerTextControlPlans(runtime: TextNodeCapabilityRuntime): void {
  const { context, buildCreateTransaction } = runtime;
  for (const version of [1, 2] as const) {
  context.capabilities.provide<CanvasControlNodeRequest, CanvasControlNodePlan>({
    key: `canvasControl.nodesPlan@${version}`,
    invoke: async (input, signal) => {
      validateCanvasControlActions(input?.actions, false, version);
      if (input.actions.some(action => action.type !== 'create-node' && action.type !== 'update-node') || !Array.isArray(input.expected)) throw new Error('文字对象计划无效');
      const patches: PatchOperation[] = [];
      const events: EventDeclaration[] = [];
      const created: Record<string, string> = Object.create(null) as Record<string, string>;
      const nodes: ContentSummary[] = [];
      const reserved: string[] = [];
      for (const [index, action] of input.actions.entries()) {
        assertNotAborted(signal);
        let node: TextNodeRecord;
        let revision: number;
        let length: number;
        const local: PatchOperation[] = [];
        if (action.type === 'create-node') {
          const plan = buildCreateTransaction({ title: action.title, body: action.text, x: action.x, y: action.y, width: action.width, height: action.height }, reserved);
          if (plan.resolvedTitle !== normalizeNodeTitle(action.title)) throw new Error(`标题“${action.title}”已被使用，请换一个标题`);
          reserved.push(plan.resolvedTitle);
          node = localNode(plan.transaction.patches, plan.nodeId);
          revision = 1;
          length = action.text?.length ?? 0;
          local.push(...plan.transaction.patches);
          events.push(...(plan.transaction.events ?? []));
          created[action.ref] = node.id;
        } else {
          const existing = context.store.readValue<TextNodeRecord>(NODE_NAMESPACE, action.id);
          const expected = input.expected.find(item => item.id === action.id);
          const content = existing && context.store.readValue<TextContentRecord>(CONTENT_NAMESPACE, existing.contentId);
          if (!existing || !content || !expected || !isCanvasTextNode(existing) || existing.revision !== expected.nodeRevision || content.revision !== expected.revision) throw new Error('文字对象已经变化，请重新生成操作计划');
          node = { ...existing, revision: existing.revision + 1, updatedAt: Date.now() };
          revision = content.revision;
          length = content.length;
          if (action.title !== undefined && action.title !== existing.title) {
            const plan = await context.capabilities.request<ContentRenamePlan>('content.renamePlan@1', { nodeId: node.id, title: action.title, expectedNodeRevision: existing.revision, reservedTitles: reserved }, signal);
            node.title = plan.resolvedTitle;
            reserved.push(node.title);
            local.push(...plan.patches);
            events.push(...(plan.events ?? []));
          }
          if (action.edit && (action.edit.expectedRevision !== content.revision || action.edit.start + action.edit.deleteCount > content.length)) throw new Error('局部修改范围或修订已失效');
          if (action.text !== undefined || action.append !== undefined || action.edit !== undefined) {
            const plan = await context.capabilities.request<ContentMutationPlan>('content.deltaPlan@1', { nodeId: node.id, expectedRevision: content.revision, start: action.edit?.start ?? (action.append === undefined ? 0 : content.length), deleteCount: action.edit?.deleteCount ?? (action.append === undefined ? content.length : 0), insert: action.edit?.insert ?? action.text ?? action.append ?? '' }, signal);
            revision = plan.revision;
            length = plan.length;
            local.push(...plan.patches);
            events.push(...(plan.events ?? []));
          }
          if (action.x !== undefined || action.y !== undefined) {
            const positions = [{ id: node.id, x: action.x ?? node.x, y: action.y ?? node.y }];
            const plan = await context.capabilities.request<ContentMovePlan>('content.movePlan@1', { positions }, signal);
            node.x = positions[0].x; node.y = positions[0].y;
            local.push(...plan.patches);
            events.push(...(plan.events ?? []));
          }
        }
        const presentation = action.presentation ?? nodePresentation(node);
        if (presentation !== nodePresentation(node)) {
          node = { ...withRememberedNodeSize(node, node.width, nodeHeight(node)), presentation };
          const size = rememberedNodeSize(node, presentation);
          node.width = size.width; node.height = size.height;
        }
        const limits = nodeResizeLimits(presentation);
        const width = action.width ?? node.width, height = action.height ?? nodeHeight(node);
        if (width < limits.minWidth || (limits.maxWidth !== undefined && width > limits.maxWidth) || height < limits.minHeight || height > limits.maxHeight) throw new Error('文字对象尺寸超出支持范围');
        node = withRememberedNodeSize({ ...node, presentation, width, height, ...(action.color ? { titleColor: action.color.toLowerCase() } : {}) }, width, height);
        // The owner combines its primary node record; foreign attachment patches retain their provenance.
        patches.push(...local.filter(patch => patch.namespace !== NODE_NAMESPACE || patch.key !== node.id));
        patches.push({ op: 'set', domain: 'document', namespace: NODE_NAMESPACE, key: node.id, value: node, schemaOwner: 'text-node' });
        if (action.type === 'update-node') {
          if (action.presentation !== undefined) events.push({ type: 'node.presentation.changed', payload: { id: node.id, presentation, width, height } });
          if (action.width !== undefined || action.height !== undefined) events.push({ type: 'node.resized', payload: { id: node.id, width, height } });
          if (action.color !== undefined) events.push({ type: 'node.appearance.changed', payload: { ids: [node.id] } });
        }
        nodes.push({ id: node.id, title: node.title, preview: '', x: node.x, y: node.y, width, height, presentation, titleColor: node.titleColor, textColor: '#202124', revision, nodeRevision: node.revision, length });
        if (index % 8 === 7) await yieldToMainThread();
      }
      assertNotAborted(signal);
      return { patches, events, created, nodes };
    },
  });
  }
}
function localNode(patches: PatchOperation[], id: string): TextNodeRecord {
  const node = patches.find(patch => patch.namespace === NODE_NAMESPACE && patch.key === id)?.value;
  if (!node) throw new Error('文字对象创建计划缺少节点');
  return node as TextNodeRecord;
}
