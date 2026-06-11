import type { StateBackend, StateSnapshot } from '../types.js';

/**
 * In-memory state backend. Useful for tests and for explicit snapshot
 * round-trips; baselines do not survive process restarts.
 */
export function memoryState(initial?: StateSnapshot): StateBackend {
  let stored: StateSnapshot | undefined = initial;
  return {
    load(): Promise<StateSnapshot | undefined> {
      return Promise.resolve(stored);
    },
    save(snapshot: StateSnapshot): Promise<void> {
      stored = snapshot;
      return Promise.resolve();
    },
    close(): Promise<void> {
      return Promise.resolve();
    },
  };
}
