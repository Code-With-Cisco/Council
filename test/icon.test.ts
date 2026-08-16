import { readFile } from 'node:fs/promises';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

describe('Windows application icon', () => {
  it('is a genuine multi-resolution ICO with PNG-backed entries', async () => {
    const bytes = await readFile(path.join(root, 'build', 'icon.ico'));
    expect(bytes.readUInt16LE(0)).toBe(0);
    expect(bytes.readUInt16LE(2)).toBe(1);
    const count = bytes.readUInt16LE(4);
    expect(count).toBeGreaterThanOrEqual(5);
    const sizes: number[] = [];
    for (let index = 0; index < count; index += 1) {
      const entry = 6 + index * 16;
      sizes.push(bytes[entry] === 0 ? 256 : bytes[entry]!);
      const offset = bytes.readUInt32LE(entry + 12);
      expect(bytes.subarray(offset, offset + 8)).toEqual(
        Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
      );
    }
    expect(sizes).toEqual(expect.arrayContaining([16, 32, 48, 256]));
  });
});
