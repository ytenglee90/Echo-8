import type { CanvasControlAdmission, CanvasControlPlan } from './canvas-control.ts';

export interface CanvasAgentQuery {
  mode: 'state' | 'selection' | 'recent' | 'search' | 'all' | 'relations';
  query?: string;
  ids?: string[];
  cursor?: number;
}
export interface CanvasAgentNode {
  id: string;
  title: string;
  revision: number;
  nodeRevision: number;
  length: number;
  x: number;
  y: number;
  width: number;
  height: number;
  color: string;
  presentation: 'card' | 'text-box';
}
export interface CanvasAgentQueryResult {
  nodes: CanvasAgentNode[];
  groups: Array<{ id: string; title: string; members: string[]; revision: number }>;
  connections: Array<{ id: string; from: string; to: string; line: 'solid' | 'dashed'; label: string; revision: number }>;
  total: number;
  nextCursor?: number;
  selectedIds?: string[];
  recentIds?: string[];
  createdIds?: string[];
  pendingTask?: { goal: string; question: string };
  tasks?: unknown;
  available: { nodes: boolean; groups: boolean; connections: boolean };
}
export interface CanvasAgentReadResult {
  id: string;
  revision: number;
  start: number;
  text: string;
  totalLength: number;
  nextStart?: number;
}
export interface CanvasAgentSubmission {
  plan: CanvasControlPlan;
  focusIds?: string[];
  setting?: { kind: 'theme'; theme: 'light' | 'dark' } | { kind: 'background'; color: string };
  clarification?: boolean;
}
export interface CanvasControlVerification {
  status: 'verified' | 'mismatch' | 'unavailable';
  checked: number;
  mismatches: Array<{ index: number; field: 'exists' | 'metadata' | 'body' | 'members' | 'endpoints' }>;
}

declare module './messages.ts' {
  interface ApplicationCapabilityMap {
    'canvasControl.agentQuery@1': MessageContract<CanvasControlAdmission & { query: CanvasAgentQuery }, CanvasAgentQueryResult>;
    'canvasControl.agentRead@1': MessageContract<CanvasControlAdmission & { id: string; start?: number; length?: number }, CanvasAgentReadResult>;
    'canvasControl.agentPlan@1': MessageContract<CanvasControlAdmission & CanvasAgentSubmission, { text: string }>;
  }
}
