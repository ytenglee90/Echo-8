import type { CommandContract } from './commands.ts';

export const NOVELFORGE_EXCHANGE_KIND = 'novelforge-canvas-exchange' as const;
export const NOVELFORGE_ARTIFACT_KIND = 'novelforge-canvas-artifact' as const;
export const NOVELFORGE_REQUEST_KIND = 'novelforge-canvas-change-request' as const;
export const NOVELFORGE_RECEIPT_KIND = 'novelforge-canvas-change-receipt' as const;
export const NOVELFORGE_PROTOCOL_VERSION = 1 as const;
export const NOVELFORGE_LOCAL_CONNECTOR_CAPABILITY = 'novelforge.localConnectorFetch@1' as const;

export type NovelForgeConnectorPath =
  | '/v1/connector/health'
  | '/v1/chat/completions'
  | '/v1/runtime/projects'
  | '/v1/runtime/snapshot'
  | '/v1/runtime/proposals';

export interface NovelForgeConnectorFetchRequest {
  path: NovelForgeConnectorPath;
  body: Record<string, unknown>;
  signal?: AbortSignal;
}

export interface NovelForgeConnectorConfiguration {
  endpoint: string;
  pairingToken: string;
}

export interface NovelForgeConnectorViewState {
  configured: boolean;
  online: boolean;
  endpoint: string;
  protocol?: string;
  message?: string;
  projects: NovelForgeProjectSummary[];
  selectedProjectId?: string;
}

export type NovelForgeEditableMode =
  | 'DIRECT_AUTHOR_COMMIT'
  | 'PROPOSAL_ONLY'
  | 'READ_ONLY';

export interface NovelForgeProjectSummary {
  project_id: string;
  title: string;
  chapter_count: number;
  stage: string;
  workflow_status: string;
  updated_at: string;
}

export interface NovelForgeManifestEntry {
  entry_id: string;
  artifact_id: string;
  artifact_type: string;
  artifact_revision: number;
  authority_digest: string;
  content_digest: string;
  authority_status: string;
  locked: boolean;
  editable_mode: NovelForgeEditableMode;
  chapter: number | null;
  card_id: string | null;
  file_path: string;
  x: number;
  y: number;
}

export interface NovelForgeManifest {
  kind: typeof NOVELFORGE_EXCHANGE_KIND;
  protocol_version: typeof NOVELFORGE_PROTOCOL_VERSION;
  schema: 'novelforge.canvas.exchange.v1';
  project: NovelForgeProjectSummary;
  generated_at: string;
  entries: NovelForgeManifestEntry[];
  snapshot_digest: string;
}

export interface NovelForgeArtifact extends NovelForgeManifestEntry {
  kind: typeof NOVELFORGE_ARTIFACT_KIND;
  protocol_version: typeof NOVELFORGE_PROTOCOL_VERSION;
  project_id: string;
  title: string;
  body: string;
  metadata: Record<string, unknown>;
}

export type NovelForgeReceiptStatus =
  | 'REVIEW_REQUIRED'
  | 'CONFLICT'
  | 'APPROVAL_REQUIRED'
  | 'COMMITTED'
  | 'REJECTED'
  | 'BLOCKED';

export interface NovelForgeChangeReceipt {
  kind: typeof NOVELFORGE_RECEIPT_KIND;
  protocol_version: typeof NOVELFORGE_PROTOCOL_VERSION;
  request_id: string;
  project_id: string;
  proposal_id: string | null;
  status: NovelForgeReceiptStatus;
  candidate_digest: string | null;
  authority_candidate_digest: string | null;
  conflict_reason: string | null;
  approval_request_id: string | null;
  result_revision: number | null;
  result_digest: string | null;
  updated_at: string;
}

export interface NovelForgeChangeRequest {
  kind: typeof NOVELFORGE_REQUEST_KIND;
  protocol_version: typeof NOVELFORGE_PROTOCOL_VERSION;
  request_id: string;
  project_id: string;
  entry_id: string;
  artifact_type: string;
  artifact_id: string;
  base_revision: number;
  base_digest: string;
  base_content_digest: string;
  canvas_node_id: string;
  canvas_node_revision: number;
  candidate_title: string;
  candidate_body: string;
  candidate_digest: string;
  created_at: string;
}

export type NovelForgeBindingState =
  | 'synced'
  | 'local-draft'
  | 'proposal-queued'
  | 'conflict'
  | 'orphaned';

export interface NovelForgeBinding {
  projectId: string;
  entryId: string;
  artifactId: string;
  artifactType: string;
  chapter?: number;
  cardId?: string;
  canvasNodeId: string;
  filePath: string;
  artifactRevision: number;
  authorityDigest: string;
  contentDigest: string;
  lastSyncedCanvasDigest: string;
  lastSyncedContentRevision: number;
  lastSyncedNodeRevision: number;
  runtimeTitle: string;
  canvasTitle: string;
  lastSyncedVersion: string;
  x: number;
  y: number;
  locked: boolean;
  editableMode: NovelForgeEditableMode;
  authorityStatus: string;
  syncState: NovelForgeBindingState;
  pendingRequestId?: string;
  pendingCandidateDigest?: string;
  pendingCanvasNodeRevision?: number;
  proposalId?: string;
  conflictReason?: string;
}

export interface NovelForgeLocalNodeState {
  entryId: string;
  nodeId: string;
  title: string;
  bodyDigest: string;
  canvasDigest: string;
  contentRevision: number;
  nodeRevision: number;
  totalLength: number;
}

export interface NovelForgePreparedSync {
  manifest: NovelForgeManifest;
  artifacts: NovelForgeArtifact[];
  localNodes: NovelForgeLocalNodeState[];
  receipts: NovelForgeChangeReceipt[];
  directoryName: string;
}

export interface NovelForgeQueuedProposal {
  entryId: string;
  requestId: string;
  candidateDigest: string;
  canvasNodeRevision: number;
}

export interface NovelForgePanelState {
  open: boolean;
  connected: boolean;
  directoryName?: string;
  project?: NovelForgeProjectSummary;
  snapshotDigest?: string;
  bindings: NovelForgeBinding[];
  counts: Record<NovelForgeBindingState, number>;
  connectionMode?: 'connector' | 'directory';
  connector: NovelForgeConnectorViewState;
}

export interface NovelForgeStatusSignal {
  state: 'running' | 'ready' | 'error';
  message: string;
}

declare module './commands.ts' {
  interface ApplicationCommandMap {
    'novelforge.open': CommandContract<undefined, void>;
    'novelforge.close': CommandContract<undefined, void>;
    'novelforge.connect': CommandContract<undefined, { connected: boolean }>;
    'novelforge.connector.configure': CommandContract<NovelForgeConnectorConfiguration, { configured: boolean }>;
    'novelforge.connector.clear': CommandContract<undefined, void>;
    'novelforge.connector.probe': CommandContract<undefined, { online: boolean }>;
    'novelforge.connector.selectProject': CommandContract<{ projectId: string }, { projectId: string }>;
    'novelforge.disconnect': CommandContract<undefined, void>;
    'novelforge.sync': CommandContract<undefined, { taskId: string }>;
    'novelforge.commitSync': CommandContract<NovelForgePreparedSync, { created: number; updated: number; conflicts: number }>;
    'novelforge.markDirty': CommandContract<{ nodeId: string }, void>;
    'novelforge.queueDirtyProposals': CommandContract<undefined, { taskId: string }>;
    'novelforge.commitQueuedProposals': CommandContract<{ queued: NovelForgeQueuedProposal[] }, { queued: number }>;
    'novelforge.clearBindings': CommandContract<undefined, { cleared: number }>;
  }
}
