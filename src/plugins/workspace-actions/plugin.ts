import { createWorkspaceActionsPlugin } from './model.ts';
import { WorkspaceActionsPanel } from './WorkspaceActionsPanel.tsx';

export const workspaceActionsPlugin = createWorkspaceActionsPlugin(WorkspaceActionsPanel);
