import type { CommandContract } from './commands.ts';

declare module './commands.ts' {
  interface ApplicationCommandMap {
    'bookLibrary.show': CommandContract<undefined, { open: boolean }>;
    'bookLibrary.enterCanvas': CommandContract<undefined, { open: boolean }>;
    'bookLibrary.createLocal': CommandContract<undefined, { open: boolean }>;
  }
}

export {};
