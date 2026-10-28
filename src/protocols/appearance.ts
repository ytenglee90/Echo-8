import type { EventDeclaration, PatchOperation } from '../core/contracts.ts';
import type { CommandContract } from './commands.ts';
import type { SelectionItem } from './selection.ts';

export type AppearanceKind =
  | 'canvas-background'
  | 'connection-line'
  | 'connection-label-background'
  | 'connection-label-text'
  | 'node-title'
  | 'text-color'
  | 'group-fill'
  | 'annotation-marker';

export interface AppearanceEntityRef {
  id: string;
  revision: number;
  expectedColor: string;
}

export interface AppearanceReadRequest {
  mode?: 'global' | 'selection';
  selectedIds: string[];
  selectedItems?: SelectionItem[];
  activeNodeId?: string;
  defaults?: Partial<Record<AppearanceKind, string>>;
}

export interface AppearanceTarget {
  kind: AppearanceKind;
  label: string;
  scopeLabel: string;
  color: string;
  mixed: boolean;
  entities: AppearanceEntityRef[];
  /** Optional screen-space anchor supplied when the selected entity is not a canvas catalog item. */
  anchor?: PaletteAnchorRect;
}

export interface AppearanceReadContribution {
  targets: AppearanceTarget[];
}

export interface AppearanceUpdateRequest {
  kind: AppearanceKind;
  color: string;
  entities: AppearanceEntityRef[];
}

export interface AppearanceUpdatePlan {
  patches: PatchOperation[];
  events?: EventDeclaration[];
  changed: number;
}

export interface AppearancePreview {
  kind?: AppearanceKind;
  color?: string;
  entityIds?: string[];
  textRange?: {
    start: number;
    end: number;
    scope: 'selection' | 'paragraph';
    contentRevision: number;
  };
  clear?: boolean;
}

export interface PalettePreferences {
  /** Retained for legacy personal workspaces; theme switching is no longer exposed by the global-color panel. */
  themeId: 'light' | 'dark';
  editorBackground: string;
  editorChromeBackground: string;
  toolbarBackground: string;
  annotationColor: string;
  /** Opaque source color; group views apply the product transparency consistently. */
  groupBackground: string;
}

export interface PalettePreferencesPatch {
  themeId?: PalettePreferences['themeId'];
  editorBackground?: string;
  editorChromeBackground?: string;
  toolbarBackground?: string;
  annotationColor?: string;
  groupBackground?: string;
}

declare module './commands.ts' {
  interface ApplicationCommandMap {
    'palette.setPreferences': CommandContract<PalettePreferencesPatch, PalettePreferences>;
  }
}

export interface PalettePanelState {
  open: boolean;
  preferences: PalettePreferences;
}

export interface PalettePreferencesPreview {
  editorBackground?: string;
  editorChromeBackground?: string;
  toolbarBackground?: string;
  annotationColor?: string;
  groupBackground?: string;
  clear?: boolean;
}

/** Rebuildable summary of title-bar colors currently used by text nodes. */
export interface PaletteTitleColorRecord {
  color: string;
  count: number;
}

export interface PaletteAnchorRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** Public request used by every color well in the application. */
export interface ColorPickerOpenRequest {
  sessionId: string;
  color: string;
  anchor: PaletteAnchorRect;
}

export interface ColorPickerCommitRequest {
  sessionId: string;
  color: string;
}

export interface ColorPickerCloseRequest {
  sessionId?: string;
  silent?: boolean;
}

export interface ColorPickerPreview {
  sessionId: string;
  color: string;
}

export interface ColorPickerResult extends ColorPickerPreview {
  committed: boolean;
}

export interface ColorPickerState extends ColorPickerOpenRequest {
  open: true;
  colors: PaletteTitleColorRecord[];
  appearancePreview?: AppearancePreview;
}

export interface NodeTitleColorPickerOpenRequest {
  targets: AppearanceEntityRef[];
  anchor: PaletteAnchorRect;
}

export interface NodeTitleColorPickerState extends NodeTitleColorPickerOpenRequest {
  open: true;
  titleColors: PaletteTitleColorRecord[];
}
