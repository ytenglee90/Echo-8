export interface AIRequestIdentity { sessionId: string; userTurn: number }
export interface AIRequestSnapshot extends AIRequestIdentity {
  id: string; timestamp: number; endpoint: string; method: string;
  headers: Record<string, string>; body?: string; bodyLength: number; omitted?: boolean;
}
export interface AIRequestInspectionState { sessionId: string; turn: number; requests: AIRequestSnapshot[]; error?: string }

declare module './commands.ts' {
  interface ApplicationCommandMap {
    'ai.request.inspect@1': CommandContract<{ sessionId: string; turn: number }>;
    'ai.request.closeInspection@1': CommandContract;
  }
}
declare module './messages.ts' {
  interface ApplicationCapabilityMap {
    'ai.provider.requestTrace@1': MessageContract<AIRequestIdentity, AIRequestSnapshot[]>;
  }
  interface ApplicationQueryMap {
    'ai.request.inspection@1': MessageContract<undefined, AIRequestInspectionState | undefined>;
  }
}
