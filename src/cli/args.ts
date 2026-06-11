/**
 * Minimal argv parser for the behavioralai CLI.
 *
 * Grammar: the first token that does not start with `--` is the command;
 * `--key value` pairs become string flags; a bare `--key` (followed by
 * another flag or by nothing) becomes `true`. No external parser is used,
 * which keeps the CLI free of runtime dependencies.
 *
 * @module
 */

/** Result of {@link parseArgs}: the command word plus its flag map. */
export interface ParsedArgs {
  /** First non-flag token; defaults to "help" when absent. */
  command: string;
  /** Parsed flags; `true` marks a bare flag passed without a value. */
  flags: ReadonlyMap<string, string | true>;
}

/**
 * Parse raw argv tokens (already stripped of the node and script entries).
 * Non-flag tokens after the command are ignored.
 */
export function parseArgs(argv: readonly string[]): ParsedArgs {
  let command: string | undefined;
  const flags = new Map<string, string | true>();
  let index = 0;
  while (index < argv.length) {
    const token = argv[index];
    if (token === undefined) break;
    if (token.startsWith('--')) {
      const key = token.slice(2);
      const next = argv[index + 1];
      if (next !== undefined && !next.startsWith('--')) {
        flags.set(key, next);
        index += 2;
      } else {
        flags.set(key, true);
        index += 1;
      }
    } else {
      if (command === undefined) command = token;
      index += 1;
    }
  }
  return { command: command ?? 'help', flags };
}

/**
 * Read a string-valued flag. Returns undefined when the flag is absent or
 * was passed bare (without a value).
 */
export function flagString(
  flags: ReadonlyMap<string, string | true>,
  key: string,
): string | undefined {
  const value = flags.get(key);
  return typeof value === 'string' ? value : undefined;
}

/**
 * Read a numeric flag. Returns undefined when the flag is absent. Throws a
 * plain Error when the flag is present without a value or with a value that
 * is not a finite number.
 */
export function flagNumber(
  flags: ReadonlyMap<string, string | true>,
  key: string,
): number | undefined {
  const value = flags.get(key);
  if (value === undefined) return undefined;
  if (value === true) {
    throw new Error(`flag --${key} requires a numeric value`);
  }
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) {
    throw new Error(`flag --${key} expects a number, received "${value}"`);
  }
  return parsed;
}
