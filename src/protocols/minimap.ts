import type { CommandContract } from './commands.ts';
import type { MessageContract } from './messages.ts';

/** Workspace-only state exposed by minimap.state@1. */
export interface MinimapState { open: boolean }
type MinimapCommand = CommandContract;
type MinimapStateCapability = MessageContract<undefined, MinimapState>;

declare module './commands.ts' {
  interface ApplicationCommandMap {
    'minimap.toggle': MinimapCommand;
    'minimap.open': MinimapCommand;
    'minimap.close': MinimapCommand;
  }
}
declare module './messages.ts' {
  interface ApplicationCapabilityMap {
    'minimap.state@1': MinimapStateCapability;
  }
}
