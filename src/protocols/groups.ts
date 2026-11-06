export interface GroupTitleStyle {
  fontSize: number;
  fontWeight: number;
}

export interface GroupTitleMark extends GroupTitleStyle {
  start: number;
  end: number;
}

export interface GroupRecord {
  id: string;
  title: string;
  memberIds: string[];
  titleStyle: GroupTitleStyle;
  titleMarks?: GroupTitleMark[];
  /** Optional object-level fill override; absence inherits the global group color. */
  color?: string;
  revision: number;
  createdAt: number;
  updatedAt: number;
}

export interface GroupDropPointer {
  x: number;
  y: number;
}

export interface GroupDropTargetRequest {
  nodeId: string;
  /** Complete dragged batch; omission preserves legacy single-node behavior. */
  nodeIds?: string[];
  pointer: GroupDropPointer;
}

export interface GroupDropTarget {
  action: 'add' | 'remove';
  groupId: string;
}

/** Ephemeral Ctrl-drag state. It never enters document state or history. */
export type GroupMembershipPreview =
  | {
      nodeId: string;
      nodeIds?: string[];
      pointer: GroupDropPointer;
      active: boolean;
    }
  | { clear: true };

export interface GroupMembershipDropRequest extends GroupDropTargetRequest {
  positions: Array<{ id: string; x: number; y: number }>;
  target: GroupDropTarget;
}

declare module './commands.ts' {
  interface ApplicationCommandMap {
    'group.membership.applySelected@1': CommandContract<{ action: 'add' | 'remove' }, { changed: number }>;
  }
}
