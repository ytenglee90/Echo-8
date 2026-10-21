import type { InteractionMode, InteractionSnapshot } from '../protocols/interactions.ts';

const transitions: Record<InteractionMode, InteractionMode[]> = {
  idle: [
    'panning',
    'selecting',
    'dragging-node',
    'resizing',
    'connecting',
    'editing-title',
    'editing-body',
    'resizing-dock',
    'immersive',
  ],
  panning: ['idle'],
  selecting: ['idle'],
  'dragging-node': ['idle'],
  resizing: ['idle'],
  connecting: ['idle'],
  'editing-title': ['idle', 'editing-body'],
  'editing-body': ['idle', 'editing-title', 'immersive'],
  'resizing-dock': ['idle'],
  immersive: ['editing-body', 'idle'],
};

export class InteractionStateMachine {
  private session: InteractionSnapshot = { mode: 'idle' };

  current(): InteractionMode {
    return this.session.mode;
  }

  snapshot(): InteractionSnapshot {
    return { ...this.session };
  }

  begin(next: Exclude<InteractionMode, 'idle'>, owner: string, sessionId: string): InteractionSnapshot {
    if (next === this.session.mode && owner === this.session.owner && sessionId === this.session.sessionId) {
      return this.snapshot();
    }
    if (!transitions[this.session.mode].includes(next)) {
      throw new Error(`Illegal interaction transition: ${this.session.mode} -> ${next}`);
    }
    this.session = { mode: next, owner, sessionId };
    return this.snapshot();
  }

  end(owner: string, mode?: Exclude<InteractionMode, 'idle'>, sessionId?: string): boolean {
    if (this.session.mode === 'idle') return false;
    if (this.session.owner !== owner) return false;
    if (mode && this.session.mode !== mode) return false;
    if (sessionId && this.session.sessionId !== sessionId) return false;
    this.session = { mode: 'idle' };
    return true;
  }
}
