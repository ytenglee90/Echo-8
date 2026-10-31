import type { FileSaveTarget } from '../../protocols/files.ts';

/**
 * Serialises writes that target the same native file handle.
 *
 * Browser file handles are not transactional. Starting a second writable while
 * the first one is still closing can truncate the file or invalidate either
 * stream, and browsers disagree about which operation wins. Different targets
 * remain independent, while every operation for one target gets a strict lane.
 */
export class FileWriteCoordinator {
  readonly #tails = new WeakMap<FileSaveTarget, Promise<void>>();

  async run<T>(
    target: FileSaveTarget,
    signal: AbortSignal,
    operation: () => Promise<T>,
  ): Promise<T> {
    const previous = this.#tails.get(target) ?? Promise.resolve();
    let release: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const tail = previous.catch(() => undefined).then(() => gate);
    this.#tails.set(target, tail);
    try {
      await waitForTurn(previous, signal);
      assertNotAborted(signal);
      return await operation();
    } finally {
      release();
      if (this.#tails.get(target) === tail) {
        void tail.finally(() => {
          if (this.#tails.get(target) === tail) this.#tails.delete(target);
        });
      }
    }
  }
}

function waitForTurn(turn: Promise<void>, signal: AbortSignal): Promise<void> {
  if (signal.aborted) return Promise.reject(abortError());
  return new Promise<void>((resolve, reject) => {
    const onAbort = () => {
      cleanup();
      reject(abortError());
    };
    const cleanup = () => signal.removeEventListener('abort', onAbort);
    signal.addEventListener('abort', onAbort, { once: true });
    void turn.then(
      () => { cleanup(); resolve(); },
      () => { cleanup(); resolve(); },
    );
  });
}

function abortError(): DOMException {
  return new DOMException('The operation was aborted', 'AbortError');
}
import { assertNotAborted } from '../../services/async-control.ts';
