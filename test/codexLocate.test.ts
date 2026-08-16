import * as path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import {
  locateCodex,
  parseCodexVersion,
} from '../src/providers/codex/locate.js';

describe('Codex executable discovery', () => {
  it('parses current and prerelease version output', () => {
    expect(parseCodexVersion('codex-cli 0.146.0')).toBe('0.146.0');
    expect(parseCodexVersion('codex-cli 0.146.0-alpha.3.1')).toBe(
      '0.146.0-alpha.3.1',
    );
    expect(parseCodexVersion('unknown')).toBeUndefined();
  });

  it('probes an explicit absolute override before PATH', async () => {
    const override = path.resolve('/opt', 'Codex App', 'codex');
    const probe = vi.fn(async (executable: string) => ({
      ok: executable === override,
      output: 'codex-cli 1.2.3',
      missing: false,
    }));

    const located = await locateCodex({
      override,
      home: path.resolve('/home', 'person'),
      exists: async () => true,
      probe,
    });

    expect(located).toEqual({
      executable: override,
      version: '1.2.3',
      discoveredVia: 'override',
    });
    expect(probe).toHaveBeenCalledExactlyOnceWith(override);
  });

  it('falls back to the bare native executable without a shell wrapper', async () => {
    const probes: string[] = [];
    const located = await locateCodex({
      override: path.resolve('/missing', 'codex'),
      home: path.resolve('/home', 'person'),
      exists: async () => false,
      probe: async (executable) => {
        probes.push(executable);
        return {
          ok: executable === 'codex.exe',
          output: 'codex-cli 2.0.0',
          missing: executable !== 'codex.exe',
        };
      },
    });

    expect(located).toEqual({
      executable: 'codex.exe',
      version: '2.0.0',
      discoveredVia: 'path',
    });
    expect(probes).toEqual(['codex.exe']);
  });

  it('returns null rather than claiming availability when every probe fails', async () => {
    expect(
      await locateCodex({
        home: path.resolve('/home', 'person'),
        exists: async () => false,
        probe: async () => ({ ok: false, output: 'missing', missing: true }),
      }),
    ).toBeNull();
  });
});
