import type { ShortcutOverride } from '../../core/contracts.ts';

export interface ShortcutCenterState {
  open: boolean;
  overrides: ShortcutOverride[];
}
