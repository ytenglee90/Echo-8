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
  const text = prompt.replace(/群组管理|群组成员管理|分组管理|编辑器设置|当前编辑器|沉浸写作/u, '界面');
  return /打开|关闭|进入|显示|展开|收起|设置|配置|切|调|唤|呼|叫|管理|窗口|面板|页面|界面/u.test(text) &&
    /设置|配置|插件|检索|索引|指令|偏好|快捷键|诊断|管理|窗口|面板|页面|界面|小地图|参考线|吸附|纠错|补全|联网|模型|模板/u.test(text) &&
    !/节点|卡片|正文|群组|连线|选中|选区|@\[|「|『|“|"/u.test(text);
}

export function isWorkspaceInterfaceAction(action: WorkspaceActionDescriptor): boolean {
  return action.effect === 'workspace' &&
    (/^settings\.|^diagnostics\.(?:open|close|log)$|^file\.panel(?:\.close)?$|^(?:commands|canvasControl)\.(?:open|close)$|^group\.management\.|^minimap\.|^search\.(?:open|close)$|^palette\.(?:open|close)$|^viewport\.tool$|^layout\.(?:guides|snap)\.toggle$|^(?:correction|completion)\.toggle$|^editor\.(?:closeActive|closeAll|next|previous|immersive\.(?:current|toggle|exit))$|^assistant\.(?:view|open|close|closeCurrent|context|web|autoMemory|provider)$/u.test(action.id) ||
      action.id === 'registered:ai-assistant:ai.open-provider-settings-action');
}

export function workspaceActionNeedsObjects(action: WorkspaceActionDescriptor): boolean {
  const scan = (value: unknown): boolean => Array.isArray(value) ? value.some(scan) : isRecord(value) &&
    (isRecord(value.properties) && Object.keys(value.properties).some(key =>
      /^(?:target|targets|id|ids|nodeId|nodeIds|sourceId|sourceIds|groupId|entityId|entityIds|anchorId|members|from|to)$/u.test(key)) ||
      Object.values(value).some(scan));
  return scan(action.inputSchema);
}
