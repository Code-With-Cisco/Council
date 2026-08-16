import { readFile } from 'node:fs/promises';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

import { buildStartSessionArgv } from '../src/integration/client.js';
import { parseFrontmatter } from '../src/integration/fs/agentDefs.js';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const AGENT_DIR = path.join(REPO_ROOT, '.claude', 'agents');
const ADVISORS = [
  'council-contrarian',
  'council-first-principles',
  'council-expansionist',
  'council-outsider',
  'council-executor',
] as const;

describe('council agent definitions', () => {
  it('gives every advisor a read-only string-form tool allowlist', async () => {
    for (const advisor of ADVISORS) {
      const source = await readFile(path.join(AGENT_DIR, `${advisor}.md`), 'utf8');
      const frontmatter = parseFrontmatter(source);
      expect(frontmatter?.['mode']).toBe('internal');
      expect(frontmatter?.['tools']).toBe('Read, Grep, Glob');
      expect(frontmatter?.['permissionMode']).toBeUndefined();
      expect(source).toContain('final output');
      expect(source).toContain('COUNCIL MEMBER SIGN-OFF');
    }
  });

  it('makes chairman read-only through tools rather than an inherited permission mode', async () => {
    const source = await readFile(path.join(AGENT_DIR, 'council-chairman.md'), 'utf8');
    const frontmatter = parseFrontmatter(source);
    expect(frontmatter?.['tools']).toBe('Read, Grep, Glob');
    expect(frontmatter?.['permissionMode']).toBeUndefined();
    expect(frontmatter?.['mode']).toBe('internal');
  });

  it('declares the exact lead-to-advisor allowlist', async () => {
    const source = await readFile(path.join(AGENT_DIR, 'council-lead.md'), 'utf8');
    const frontmatter = parseFrontmatter(source);
    expect(frontmatter?.['name']).toBe('council-lead');
    expect(frontmatter?.['mode']).toBe('internal');
    expect(frontmatter?.['tools']).toBe(
      'Agent(council-contrarian, council-first-principles, council-expansionist, council-outsider, council-executor, council-chairman), Read, Grep, Glob',
    );
    expect(source).toContain('five substantive responses');
    expect(source).toContain('Response A');
    expect(source).toContain('chairman');
    expect(source).toContain('COUNCIL MEMBER SIGN-OFF');
    expect(source).toContain('independently started Claude sessions');
  });

  it('keeps routing metadata in descriptions rather than prompt-body trailers', async () => {
    const names = [...ADVISORS, 'council-chairman'] as const;
    const descriptions = new Set<string>();
    for (const name of names) {
      const source = await readFile(path.join(AGENT_DIR, `${name}.md`), 'utf8');
      const frontmatter = parseFrontmatter(source);
      const description = frontmatter?.['description'];
      expect(typeof description).toBe('string');
      expect(String(description)).toMatch(/Use (?:only )?as|Use as/);
      expect(source).not.toContain('SHOULD route:');
      expect(source).not.toContain('SHOULD NOT route:');
      expect(descriptions.has(String(description))).toBe(false);
      descriptions.add(String(description));
    }
  });
});

describe('council dispatch argv', () => {
  it('passes the exact question as one argv element without a shell', () => {
    const question = 'Review "C:\\Program Files\\Council"; Remove-Item should remain text.';
    const argv = buildStartSessionArgv({
      agent: 'council-lead',
      name: 'Council',
      prompt: question,
      cwd: 'C:\\work\\Council',
    });
    expect(argv).toEqual([
      '--bg',
      '--agent',
      'council-lead',
      '--name',
      'Council',
      question,
    ]);
  });
});
