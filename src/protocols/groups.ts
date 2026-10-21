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
      pointer: GroupDropPointer;
      active: boolean;
    }
  | { clear: true };

export interface GroupMembershipDropRequest extends GroupDropTargetRequest {
  positions: Array<{ id: string; x: number; y: number }>;
  target: GroupDropTarget;
}
