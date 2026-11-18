export interface WorkspaceActionDescriptor {
  id: string;
  owner: string;
  label: string;
  category: string;
  effect: 'query' | 'workspace' | 'document' | 'file';
  parameters: Readonly<Record<string, string>>;
  inputSchema?: Record<string, unknown>;
  resultMode?: 'returned' | 'readback' | 'confirmation';
  /** Current formal commands, queries and capabilities used by this adapter. */
  sourceKeys?: string[];
  status: 'available' | 'inactive' | 'manual';
}

export interface WorkspaceActionIndex {
  version: 1;
  actions: WorkspaceActionDescriptor[];
  registry: WorkspaceRuntimeCatalog;
}

export interface WorkspaceRuntimeCatalog {
  version: 1;
  commands: Array<{ type: string; owner: string; available: boolean }>;
  queries: Array<{ type: string; owner: string; available: boolean }>;
  capabilities: Array<{ key: string; providers: string[] }>;
}

export interface WorkspaceCoverageReport {
  version: 1;
  categories: Array<{ id: string; name: string; scope: string; sourceKeys: string[];
    acceptance: { input: string; expected: string }; actions: Array<Pick<WorkspaceActionDescriptor, 'id' | 'status'>>;
    registered: string[]; missing: string[]; acceptanceStatus: 'not-run'; limits: string[] }>;
  crossCategory: Array<{ id: string; name: string; scope: string; acceptance: { input: string; expected: string }; acceptanceStatus: 'not-run';
    actions?: Array<Pick<WorkspaceActionDescriptor, 'id' | 'status'>> }>;
  scenarios: Array<{ id: string; coverageIds: string[]; scenario: string; expected: string; acceptanceStatus: 'not-run' }>;
  note: string;
}

export type WorkspaceTarget =
  | { id: string }
  | { title: string }
  | { from: string };

export interface WorkspacePlanStep {
  id: string;
  action: string;
  arguments?: Record<string, unknown>;
  dependsOn?: string[];
  /** Branch on whether an earlier object lookup returned any matches. */
  when?: { step: string; exists: boolean };
}

export interface WorkspacePlan {
  version: 1;
  /** Caller-scoped retry identity. */
  id: string;
  steps: WorkspacePlanStep[];
  constraints?: { effectScope?: 'read-only' | 'workspace'; documentRevision?: number };
  verify?: Array<{ action: string; arguments?: Record<string, unknown>; field: string[]; equals: unknown }>;
}

export interface WorkspaceStepReceipt {
  id: string;
  action: string;
  status: 'completed' | 'waiting' | 'failed' | 'skipped';
  result?: unknown;
  message?: string;
}

export interface WorkspacePlanReceipt {
  id: string;
  status: 'completed' | 'waiting' | 'partial' | 'failed' | 'cancelled' | 'expired';
  steps: WorkspaceStepReceipt[];
}
export interface WorkspacePlanValidation { steps: Array<{ label: string; effect: WorkspaceActionDescriptor['effect'] }> }

export interface WorkspacePlanResume {
  id: string;
  /** Bind only a candidate explicitly returned for this waiting step. */
  choices?: Record<string, { argument: string; index?: number; id: string }>;
  /** Apply only a document preview returned by this plan. */
  apply?: string[];
  retryFailed?: boolean;
}

export interface WorkspaceQueryTaskReceipt {
  id: string;
  state: 'running' | 'completed' | 'failed' | 'cancelled';
  result?: unknown;
  message?: string;
}

declare module './messages.ts' {
  interface ApplicationQueryMap {
    'system.actionCatalog@1': MessageContract<undefined, WorkspaceRuntimeCatalog>;
    'system.action.validate@1': MessageContract<{ owner: string; id: string; arguments?: unknown }, { valid: boolean }>;
    'workspace.actions@1': MessageContract<undefined, WorkspaceActionIndex>;
    'workspace.plan.validate@1': MessageContract<WorkspacePlan, WorkspacePlanValidation>;
    'workspace.coverage@1': MessageContract<undefined, WorkspaceCoverageReport>;
    'workspace.plan.receipt@1': MessageContract<{ id: string }, WorkspacePlanReceipt | undefined>;
    'workspace.plan.latest@1': MessageContract<undefined, { plan: WorkspacePlan; receipt: WorkspacePlanReceipt } | undefined>;
    'workspace.queryTask@1': MessageContract<{ id: string }, WorkspaceQueryTaskReceipt | undefined>;
    'workspace.actions.state@1': MessageContract<undefined, { open: boolean }>;
  }
}

declare module './commands.ts' {
  interface ApplicationCommandMap {
    'workspace.plan.run@1': CommandContract<WorkspacePlan, WorkspacePlanReceipt>;
    'workspace.plan.resume@1': CommandContract<WorkspacePlanResume, WorkspacePlanReceipt>;
    'workspace.plan.cancel@1': CommandContract<{ id: string }, WorkspacePlanReceipt>;
    'workspace.actions.open@1': CommandContract<undefined, unknown>;
    'workspace.actions.close@1': CommandContract<undefined, unknown>;
    'system.action.invoke@1': CommandContract<{ owner: string; id: string; arguments?: unknown }, unknown>;
  }
}
