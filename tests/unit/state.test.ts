import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { StateError } from '../../src/errors.js';
import { fileState } from '../../src/state/file.js';
import { memoryState } from '../../src/state/memory.js';
import type { StateSnapshot } from '../../src/types.js';

const SNAPSHOT: StateSnapshot = {
  version: 1,
  savedAt: 1_750_000_000_000,
  agents: { 'agent-x': { observations: 10 } },
};

describe('memoryState', () => {
  it('round-trips a snapshot and starts empty', async () => {
    const backend = memoryState();
    expect(await backend.load()).toBeUndefined();
    await backend.save(SNAPSHOT);
    expect(await backend.load()).toEqual(SNAPSHOT);
    await backend.close();
  });

  it('accepts an initial snapshot', async () => {
    const backend = memoryState(SNAPSHOT);
    expect(await backend.load()).toEqual(SNAPSHOT);
  });
});

describe('fileState', () => {
  it('rejects an empty path eagerly', () => {
    expect(() => fileState({ path: '' })).toThrow(StateError);
  });

  it('returns undefined for a missing file', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'behavioralai-'));
    const backend = fileState({ path: join(dir, 'missing.json') });
    expect(await backend.load()).toBeUndefined();
  });

  it('saves atomically and loads back', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'behavioralai-'));
    const path = join(dir, 'nested', 'state.json');
    const backend = fileState({ path });
    await backend.save(SNAPSHOT);
    expect(JSON.parse(readFileSync(path, 'utf8'))).toEqual(SNAPSHOT);
    expect(await backend.load()).toEqual(SNAPSHOT);
    await backend.close();
  });

  it('throws StateError on invalid JSON', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'behavioralai-'));
    const path = join(dir, 'broken.json');
    const fs = await import('node:fs/promises');
    await fs.writeFile(path, 'not json', 'utf8');
    const backend = fileState({ path });
    await expect(backend.load()).rejects.toBeInstanceOf(StateError);
  });

  it('throws StateError on an unsupported snapshot shape', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'behavioralai-'));
    const path = join(dir, 'wrong-version.json');
    const fs = await import('node:fs/promises');
    await fs.writeFile(path, JSON.stringify({ version: 99, agents: {} }), 'utf8');
    const backend = fileState({ path });
    await expect(backend.load()).rejects.toBeInstanceOf(StateError);
  });
});
