import { StateError } from '../errors.js';
import type { StateBackend, StateSnapshot } from '../types.js';

/** Options for {@link fileState}. */
export interface FileStateOptions {
  /** Path of the JSON snapshot file, for example ".behavioralai/state.json". */
  readonly path: string;
}

/**
 * File-backed state persistence (Node only). Writes are atomic: the snapshot
 * lands in a temporary sibling first and is renamed into place, so a crash
 * mid-write can never corrupt the previous baseline. `node:fs` is imported
 * lazily inside the functions, which keeps the core entry importable in
 * browsers and edge runtimes that never call this factory at runtime.
 */
export function fileState(options: FileStateOptions): StateBackend {
  const path = options.path;
  if (typeof path !== 'string' || path.length === 0) {
    throw new StateError('fileState: `path` must be a non-empty string.');
  }

  return {
    async load(): Promise<StateSnapshot | undefined> {
      const fs = await import('node:fs/promises');
      let raw: string;
      try {
        raw = await fs.readFile(path, 'utf8');
      } catch (cause) {
        if (isNotFound(cause)) return undefined;
        throw new StateError(`fileState: failed to read ${path}`, { cause });
      }
      try {
        const parsed = JSON.parse(raw) as StateSnapshot;
        if (parsed === null || typeof parsed !== 'object' || parsed.version !== 1) {
          throw new StateError(`fileState: unsupported snapshot shape in ${path}`);
        }
        return parsed;
      } catch (cause) {
        if (cause instanceof StateError) throw cause;
        throw new StateError(`fileState: invalid JSON in ${path}`, { cause });
      }
    },

    async save(snapshot: StateSnapshot): Promise<void> {
      const fs = await import('node:fs/promises');
      const nodePath = await import('node:path');
      const dir = nodePath.dirname(path);
      const temp = nodePath.join(dir, `.${nodePath.basename(path)}.tmp`);
      try {
        await fs.mkdir(dir, { recursive: true });
        await fs.writeFile(temp, JSON.stringify(snapshot), 'utf8');
        await fs.rename(temp, path);
      } catch (cause) {
        throw new StateError(`fileState: failed to write ${path}`, { cause });
      }
    },

    close(): Promise<void> {
      return Promise.resolve();
    },
  };
}

function isNotFound(cause: unknown): boolean {
  return (
    typeof cause === 'object' &&
    cause !== null &&
    'code' in cause &&
    (cause as { code?: string }).code === 'ENOENT'
  );
}
