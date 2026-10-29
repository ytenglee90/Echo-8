import type { EventDeclaration, PatchOperation } from './state.ts';

export type SelectionMode = 'replace' | 'add' | 'remove' | 'toggle';

export interface SelectionItem {
  id: string;
  kind: string;
  /** Optional owner-declared visual part, such as a connection label background or its text. */
  part?: string;
}

export interface SelectionSnapshot {
  ids: string[];
  items: SelectionItem[];
}

/** Read-only resolution of a proposed selection and any entities owned by a selected container. */
export interface SelectionResolution extends SelectionSnapshot {
  /** Directly selected IDs plus recursively contained entities used by whole-container operations. */
  expandedIds: string[];
}

export interface SelectionResolutionRequest extends SelectionSetPayload {
  /** Point-drag semantics: keep a mixed selection when the pointed entity is already inside it. */
  preserveIfSelected?: boolean;
  /** Version-one compatibility flag. Members are now independently selectable in every mode. */
  moveContainedItemsDirectly?: boolean;
}

export interface SelectionSetPayload {
  ids?: string[];
  items?: SelectionItem[];
  mode?: SelectionMode;
}

export interface SelectableEntity extends SelectionItem {
  bounds?: { x: number; y: number; width: number; height: number };
  /** Entities affected when this container itself is selected for a batch operation. */
  contains?: string[];
  /** Optional precise regions used by lasso selection while `bounds` remains the focus/extent box. */
  boxRegions?: Array<{ x: number; y: number; width: number; height: number }>;
  /** Containers can require the lasso to cover their whole bounds instead of merely touching them. */
  boxMatch?: 'intersect' | 'contain';
  /** Set false for entities that remain directly selectable but must not join Select All. */
  includeInSelectAll?: boolean;
  /** Direct-selection parts accepted for this entity without changing its durable identity. */
  parts?: string[];
}

export interface SelectionCatalogContribution {
  owner: string;
  entities: SelectableEntity[];
}

export interface SelectionBoxPayload {
  x: number;
  y: number;
  width: number;
  height: number;
  mode?: SelectionMode;
}

export interface SelectionAllPayload {
  /** Latest pointer location in world coordinates, supplied by the canvas input service. */
  point?: { x: number; y: number };
}

export interface SelectionScopeAtRequest {
  point: { x: number; y: number };
}

export interface SelectionScopeContribution {
  owner: string;
  priority?: number;
  items: SelectionItem[];
}

export interface EntityDeletePlan {
  patches: PatchOperation[];
  events?: EventDeclaration[];
}
