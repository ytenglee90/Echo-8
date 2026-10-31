/** A command's compile-time payload and result contract. Runtime validation is still mandatory. */
export interface CommandContract<TPayload = undefined, TResult = void> {
  payload: TPayload;
  result: TResult;
}

/**
 * The application-wide command registry. Owning protocol modules extend this
 * interface through declaration merging so core never imports plugin code.
 */
// eslint-disable-next-line @typescript-eslint/no-empty-object-type -- intentionally extended by protocol modules
export interface ApplicationCommandMap {}

export type KnownCommandType = Extract<keyof ApplicationCommandMap, string>;
export type CommandPayload<TType extends KnownCommandType> = ApplicationCommandMap[TType]['payload'];
export type CommandResult<TType extends KnownCommandType> = ApplicationCommandMap[TType]['result'];
export type CommandArguments<TType extends KnownCommandType> =
  undefined extends CommandPayload<TType>
    ? [payload?: CommandPayload<TType>]
    : [payload: CommandPayload<TType>];
export interface CommandDispatcher {
  <TType extends KnownCommandType>(
    type: TType,
    ...args: CommandArguments<TType>
  ): Promise<CommandResult<TType>>;
}

export interface CommandDeferrer {
  <TType extends KnownCommandType>(type: TType, ...args: CommandArguments<TType>): void;
}
