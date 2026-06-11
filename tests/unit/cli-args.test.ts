import { describe, expect, it } from 'vitest';
import { flagNumber, flagString, parseArgs } from '../../src/cli/args.js';

describe('parseArgs', () => {
  it('defaults to the help command when argv is empty', () => {
    const parsed = parseArgs([]);
    expect(parsed.command).toBe('help');
    expect(parsed.flags.size).toBe(0);
  });

  it('defaults to help when argv contains only flags', () => {
    const parsed = parseArgs(['--port', '8787']);
    expect(parsed.command).toBe('help');
    expect(parsed.flags.get('port')).toBe('8787');
  });

  it('takes the first positional token as the command and ignores later positionals', () => {
    const parsed = parseArgs(['simulate', 'extra', 'tokens']);
    expect(parsed.command).toBe('simulate');
    expect(parsed.flags.size).toBe(0);
  });

  it('parses --key value pairs into string flags', () => {
    const parsed = parseArgs(['serve', '--port', '8787', '--host', '127.0.0.1']);
    expect(parsed.command).toBe('serve');
    expect(parsed.flags.get('port')).toBe('8787');
    expect(parsed.flags.get('host')).toBe('127.0.0.1');
    expect(parsed.flags.size).toBe(2);
  });

  it('records a bare trailing flag as true', () => {
    const parsed = parseArgs(['serve', '--watch']);
    expect(parsed.flags.get('watch')).toBe(true);
  });

  it('keeps a flag true when it is immediately followed by another flag', () => {
    const parsed = parseArgs(['serve', '--watch', '--port', '9000']);
    expect(parsed.flags.get('watch')).toBe(true);
    expect(parsed.flags.get('port')).toBe('9000');
  });
});

describe('flagString', () => {
  it('returns the string value when the flag carries a value', () => {
    const { flags } = parseArgs(['serve', '--host', '0.0.0.0']);
    expect(flagString(flags, 'host')).toBe('0.0.0.0');
  });

  it('returns undefined when the flag is absent', () => {
    const { flags } = parseArgs(['serve']);
    expect(flagString(flags, 'host')).toBeUndefined();
  });

  it('returns undefined when the flag was passed bare', () => {
    const { flags } = parseArgs(['serve', '--host']);
    expect(flagString(flags, 'host')).toBeUndefined();
  });
});

describe('flagNumber', () => {
  it('parses a numeric flag value', () => {
    const { flags } = parseArgs(['simulate', '--turns', '160']);
    expect(flagNumber(flags, 'turns')).toBe(160);
  });

  it('parses fractional and negative values', () => {
    const { flags } = parseArgs(['simulate', '--ratio', '0.5', '--offset', '-3']);
    expect(flagNumber(flags, 'ratio')).toBe(0.5);
    expect(flagNumber(flags, 'offset')).toBe(-3);
  });

  it('returns undefined when the flag is absent', () => {
    const { flags } = parseArgs(['simulate']);
    expect(flagNumber(flags, 'turns')).toBeUndefined();
  });

  it('throws when the flag was passed bare without a value', () => {
    const { flags } = parseArgs(['simulate', '--turns']);
    expect(() => flagNumber(flags, 'turns')).toThrow('flag --turns requires a numeric value');
  });

  it('throws when the value is not a finite number', () => {
    const { flags } = parseArgs(['simulate', '--turns', 'many']);
    expect(() => flagNumber(flags, 'turns')).toThrow(
      'flag --turns expects a number, received "many"',
    );
  });

  it('throws on non-finite numeric spellings such as Infinity', () => {
    const { flags } = parseArgs(['simulate', '--turns', 'Infinity']);
    expect(() => flagNumber(flags, 'turns')).toThrow(
      'flag --turns expects a number, received "Infinity"',
    );
  });
});
