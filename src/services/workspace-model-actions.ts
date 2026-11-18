import type { WorkspaceActionDescriptor } from '../protocols/workspace-actions.ts';

/** File authorizations and remote account mutations retain their dedicated user flows. */
export function isWorkspaceModelAction(action: WorkspaceActionDescriptor): boolean {
  return action.status === 'available' && Boolean(action.inputSchema) && action.effect !== 'file' &&
    action.id !== 'canvas.batch.preview' &&
    !/^(?:cloud\.|recovery\.restore|assistant\.(?:transcript|memories)|registered:cloud-sync:)/u.test(action.id);
}
