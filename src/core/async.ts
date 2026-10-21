/** Yields one event-loop turn so bounded work does not monopolize the UI thread. */
export function yieldToMainThread(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}
