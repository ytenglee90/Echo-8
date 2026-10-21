import { GroupActions } from './GroupActions.tsx';
import { GroupLayer } from './GroupLayer.tsx';
import { GroupMembershipPanel } from './GroupMembershipPanel.tsx';
import { createGroupsPlugin } from './model.ts';

export const groupsPlugin = createGroupsPlugin(GroupLayer, GroupActions, GroupMembershipPanel);
