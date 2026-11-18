
declare module './commands.ts' {
  interface ApplicationCommandMap {
    'bookLibrary.show': CommandContract<undefined, { open: boolean }>;
    'bookLibrary.enterCanvas': CommandContract<undefined, { open: boolean }>;
    'bookLibrary.createLocal': CommandContract<undefined, { open: boolean }>;
  }
}

declare module './messages.ts' {
  interface ApplicationQueryMap {
    'bookLibrary.state@1': MessageContract<undefined, { open: boolean }>;
  }
}

export {};
