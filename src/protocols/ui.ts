import type { UISlot } from '../core/contracts.ts';

export const UI_SURFACE_REVEALED_EVENT = 'system.ui.surface.revealed';

export interface UISurfaceRevealedEvent {
  slot: UISlot;
  owner: string;
  contributionId: string;
}

export function uiSurfaceRevealed(
  slot: UISlot,
  owner: string,
  contributionId: string,
): UISurfaceRevealedEvent {
  return { slot, owner, contributionId };
}
