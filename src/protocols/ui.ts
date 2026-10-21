import type { UISlot } from '../core/contracts.ts';

export const UI_SURFACE_REVEALED_EVENT = 'system.ui.surface.revealed';

export interface UISurfaceRevealedEvent {
  slot: UISlot;
}

