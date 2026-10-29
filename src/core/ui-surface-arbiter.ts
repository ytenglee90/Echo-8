import type { MessageEnvelope, UISlot } from './contracts.ts';
import { DiagnosticsService } from './diagnostics.ts';
import { MessageRouter } from './message-router.ts';
import { UIRuntime } from './ui-runtime.ts';
import {
  UI_SURFACE_REVEALED_EVENT,
  type UISurfaceRevealedEvent,
} from '../protocols/ui.ts';

const CONFLICTING_SURFACE_SLOTS: Partial<Record<UISlot, readonly UISlot[]>> = {
  'right.editor': ['right.primary'],
  'right.primary': ['right.primary', 'right.editor'],
};

/**
 * Resolves governed UI-slot conflicts after a feature has committed its intent
 * to reveal a surface. Owners close themselves through their public command;
 * the arbiter never mutates another plugin's workspace state.
 */
export class UISurfaceArbiter {
  private readonly pendingClosures = new Set<string>();
  private readonly router: MessageRouter;
  private readonly ui: UIRuntime;
  private readonly diagnostics: DiagnosticsService;

  constructor(
    router: MessageRouter,
    ui: UIRuntime,
    diagnostics: DiagnosticsService,
  ) {
    this.router = router;
    this.ui = ui;
    this.diagnostics = diagnostics;
  }

  start(): () => void {
    return this.router.subscribeEvent(
      'core.ui',
      UI_SURFACE_REVEALED_EVENT,
      (envelope) => this.reconcile(envelope as MessageEnvelope<UISurfaceRevealedEvent>),
    );
  }

  private reconcile(envelope: MessageEnvelope<UISurfaceRevealedEvent>): void {
    const slot = envelope.payload?.slot;
    const owner = envelope.payload?.owner;
    const contributionId = envelope.payload?.contributionId;
    const conflictingSlots = slot ? CONFLICTING_SURFACE_SLOTS[slot] : undefined;
    if (!conflictingSlots || !owner || !contributionId) {
      this.diagnostics.record('warn', 'core.ui', 'Ignored an invalid UI surface reveal event', envelope.payload);
      return;
    }
    const surface = this.ui.topSurface([...conflictingSlots], {
      owner,
      id: contributionId,
      slot,
    });
    if (!surface) return;
    const yieldCommand = surface.yieldCommand ?? surface.closeCommand;
    if (!yieldCommand) {
      this.diagnostics.record(
        'warn',
        'core.ui',
        `Surface cannot yield without a public close command: ${surface.owner}:${surface.id}`,
      );
      return;
    }
    const key = `${surface.owner}:${surface.id}`;
    if (this.pendingClosures.has(key)) return;
    this.pendingClosures.add(key);
    void this.router.dispatch(yieldCommand, undefined, 'core.ui', envelope)
      .catch((error) => {
        this.diagnostics.record(
          'error',
          'core.ui',
          `Failed to yield conflicting surface: ${key}`,
          error,
        );
      })
      .finally(() => this.pendingClosures.delete(key));
  }
}
