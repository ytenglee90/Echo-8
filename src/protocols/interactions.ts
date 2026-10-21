import type { CommandContract } from './commands.ts';

export type InteractionMode =
  | 'idle'
  | 'panning'
  | 'selecting'
  | 'dragging-node'
  | 'resizing'
  | 'connecting'
  | 'editing-title'
  | 'editing-body'
  | 'resizing-dock'
  | 'immersive';

export interface InteractionSnapshot {
  mode: InteractionMode;
  owner?: string;
  sessionId?: string;
}

export interface InteractionBeginRequest {
  mode: Exclude<InteractionMode, 'idle'>;
  /** Optional stable gesture identity. Core creates one when omitted. */
  sessionId?: string;
}

export interface InteractionEndRequest {
  mode?: Exclude<InteractionMode, 'idle'>;
  sessionId?: string;
}

export function isInteractionMode(value: unknown): value is InteractionMode {
  return [
    'idle',
    'panning',
    'selecting',
    'dragging-node',
    'resizing',
    'connecting',
    'editing-title',
    'editing-body',
    'resizing-dock',
    'immersive',
  ].includes(String(value));
}

declare module './commands.ts' {
  interface ApplicationCommandMap {
    'interaction.begin': CommandContract<InteractionBeginRequest, InteractionSnapshot>;
    'interaction.end': CommandContract<InteractionEndRequest | undefined, InteractionSnapshot & { ended: boolean }>;
  }
}
