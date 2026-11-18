import type { WorkspaceActionDescriptor } from '../protocols/workspace-actions.ts';
import { isRecord } from '../core/contracts.ts';

/** File authorizations and remote account mutations retain their dedicated user flows. */
export function isWorkspaceModelAction(action: WorkspaceActionDescriptor): boolean {
  return action.status === 'available' && Boolean(action.inputSchema) && action.effect !== 'file' &&
    action.id !== 'canvas.batch.preview' &&
    !/^(?:cloud\.|recovery\.restore|assistant\.(?:transcript|memories)|registered:cloud-sync:)/u.test(action.id);
}

/** Interface-only requests need action schemas, never document metadata. */
export function isWorkspaceInterfaceRequest(prompt: string): boolean {
  return /打开|关闭|进入|显示|展开|收起|设置|配置|带我去/u.test(prompt) &&
    /设置|配置|插件|检索|索引|指令与偏好|个人用语|快捷键|诊断/u.test(prompt) &&
    !/节点|卡片|正文|群组|连线|选中|选区|@\[|「|『|“|"/u.test(prompt);
}

export function isWorkspaceInterfaceAction(action: WorkspaceActionDescriptor): boolean {
  return action.effect === 'workspace' &&
    (/^settings\.|^diagnostics\.(?:open|close|log)$|^file\.panel(?:\.close)?$/u.test(action.id) ||
      action.id === 'registered:ai-assistant:ai.open-provider-settings-action');
}

export function workspaceActionNeedsObjects(action: WorkspaceActionDescriptor): boolean {
  const scan = (value: unknown): boolean => Array.isArray(value) ? value.some(scan) : isRecord(value) &&
    (isRecord(value.properties) && Object.keys(value.properties).some(key =>
      /^(?:target|targets|id|ids|nodeId|nodeIds|sourceId|sourceIds|groupId|entityId|entityIds|anchorId|members|from|to)$/u.test(key)) ||
      Object.values(value).some(scan));
  return scan(action.inputSchema);
}
